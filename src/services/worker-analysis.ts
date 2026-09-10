import { D1AnalysisJobRepository, type AnalysisJob } from "../repositories/d1-analysis-jobs.js";
import { D1AnalysisRepository } from "../repositories/d1-analysis.js";
import { D1PaperRepository } from "../repositories/d1-papers.js";
import type { D1Database } from "../cloudflare/d1.js";
import { MATH_FORMATTING_INSTRUCTION, OpenAiLlmClient, type LlmClient } from "./llm.js";
import { excludeAppendixMaterial, hasRequiredSummaryHeadings, splitTextIntoPageChunks, SUMMARY_HEADINGS, SUMMARY_PROMPT_VERSION, QUESTION_PROMPT_VERSION } from "./pdf-analysis-core.js";
import type { R2BucketLike } from "./r2-storage.js";
import type { AiSettings, QuestionAnswer, SummaryRecord } from "../repositories/analysis.js";
import { hostedQuestionDefinitions } from "./question-catalog.js";
import { PDFDocument } from "pdf-lib";
import { compactQuickSummary, generateQuickSummary } from "./quick-summary.js";

interface MarkdownConversionResult {
  format: "markdown" | "text" | "error";
  data?: string;
  error?: string;
}

export interface WorkersAiMarkdownBinding {
  toMarkdown(
    document: { name: string; blob: Blob },
    options?: { conversionOptions?: { output?: { format?: "markdown" | "text" }; pdf?: { metadata?: boolean } } },
  ): Promise<MarkdownConversionResult>;
}

export interface WorkerAnalysisEnvironment {
  DB: D1Database;
  PAPER_PDFS: R2BucketLike;
  AI?: WorkersAiMarkdownBinding;
  OPENAI_API_KEY?: string;
}

type ExtractedPaper = { text: string; sha256?: string };
type SelectedLlm = { client: LlmClient; provider: "openai"; model: string };
const SUMMARY_CHUNK_CONCURRENCY = 4;
const MIN_EXTRACTED_TEXT_CHARACTERS = 200;
const QUICK_SUMMARY_PAGE_COUNT = 4;
const PDF_PAGE_BATCH_SIZE = 10;
const SUMMARY_DIGEST_MAX_OUTPUT_TOKENS = 2_500;
const SUMMARY_REDUCTION_MAX_OUTPUT_TOKENS = 1_800;
const SUMMARY_FINAL_MAX_OUTPUT_TOKENS = 6_000;
const SUMMARY_MAX_REDUCTION_ROUNDS = 4;
const HOSTED_SUMMARY_MODEL = "gpt-4.1-mini";
const extractionInFlight = new Map<string, Promise<ExtractedPaper>>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function selectedLlm(env: WorkerAnalysisEnvironment, settings: AiSettings, modelOverride?: string): SelectedLlm {
  if (settings.provider !== "openai") throw new Error("OLLAMA_HOSTED_UNSUPPORTED");
  if (!env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_KEY_NOT_CONFIGURED");
  return {
    client: new OpenAiLlmClient({ openaiApiKey: async () => env.OPENAI_API_KEY, fetcher: (input, init) => fetch(input, init) }),
    provider: "openai",
    model: modelOverride || settings.openaiModel,
  };
}

async function mapWithConcurrency<Input, Output>(items: Input[], limit: number, mapper: (item: Input, index: number) => Promise<Output>): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

type PdfExtractionScope = "full" | "opening-pages";
type WaitUntil = (promise: Promise<unknown>) => void;

async function extractPdfOnce(env: WorkerAnalysisEnvironment, paper: { id: string; r2Key?: string; pdfSha256?: string }, scope: PdfExtractionScope = "full", jobs?: D1AnalysisJobRepository, jobId?: string): Promise<ExtractedPaper> {
  if (!env.AI) throw new Error("PDF_EXTRACTOR_UNAVAILABLE");
  if (!paper.r2Key) throw new Error("PDF_NOT_FOUND");
  const cacheKey = paper.pdfSha256
    ? `${scope === "opening-pages" ? "analysis-text-opening-v1" : "analysis-text-v3"}/${paper.id}/${paper.pdfSha256}.txt`
    : undefined;
  if (cacheKey) {
    const cached = await env.PAPER_PDFS.get(cacheKey);
    if (cached) return { text: new TextDecoder().decode(await cached.arrayBuffer()), sha256: paper.pdfSha256 };
  }
  const object = await env.PAPER_PDFS.get(paper.r2Key);
  if (!object) throw new Error("PDF_NOT_FOUND");
  const pdfBytes = await object.arrayBuffer();
  const source = await PDFDocument.load(pdfBytes);
  const pageTotal = Math.min(scope === "opening-pages" ? QUICK_SUMMARY_PAGE_COUNT : source.getPageCount(), source.getPageCount());
  if (!pageTotal) throw new Error("PDF_TEXT_EMPTY");

  // Convert at most ten pages per request. A single conversion of a long PDF can
  // exceed Workers AI's 50M-character response limit before analysis can begin.
  const extracted: string[] = [];
  for (let startPage = 0; startPage < pageTotal; startPage += PDF_PAGE_BATCH_SIZE) {
    const endPage = Math.min(startPage + PDF_PAGE_BATCH_SIZE, pageTotal);
    if (jobs && jobId) await jobs.updatePhase(jobId, `extracting:${startPage + 1}-${endPage}:${pageTotal}`);
    const batch = await PDFDocument.create();
    const pages = await batch.copyPages(source, Array.from({ length: endPage - startPage }, (_, index) => startPage + index));
    pages.forEach((page) => batch.addPage(page));
    const batchBytes = await batch.save({ useObjectStreams: true, addDefaultPage: false });
    const inputBuffer = new Uint8Array(batchBytes.byteLength);
    inputBuffer.set(batchBytes);
    const result = await env.AI.toMarkdown(
      { name: `${paper.id}-pages-${startPage + 1}-${endPage}.pdf`, blob: new Blob([inputBuffer.buffer as ArrayBuffer], { type: "application/pdf" }) },
      { conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } },
    );
    if (result.format === "error" || !result.data?.trim()) throw new Error(result.error || "PDF_TEXT_EMPTY");
    extracted.push(result.data.trim());
  }
  const text = extracted.join("\n\n").trim();
  if (text.length < MIN_EXTRACTED_TEXT_CHARACTERS) throw new Error("PDF_TEXT_INSUFFICIENT");
  if (cacheKey) await env.PAPER_PDFS.put(cacheKey, text, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return { text, sha256: paper.pdfSha256 };
}

async function extractPdf(env: WorkerAnalysisEnvironment, paper: { id: string; r2Key?: string; pdfSha256?: string }, scope: PdfExtractionScope = "full", jobs?: D1AnalysisJobRepository, jobId?: string): Promise<ExtractedPaper> {
  const key = paper.pdfSha256 ? `${scope}:${paper.id}:${paper.pdfSha256}` : `${scope}:${paper.r2Key || paper.id}`;
  const existing = extractionInFlight.get(key);
  if (existing) return existing;
  const extraction = extractPdfOnce(env, paper, scope, jobs, jobId);
  extractionInFlight.set(key, extraction);
  try { return await extraction; }
  finally { if (extractionInFlight.get(key) === extraction) extractionInFlight.delete(key); }
}

function messages(content: string) {
  return [
    { role: "system" as const, content: `You summarize scientific papers accurately. Use only the supplied paper text, preserve uncertainty, and do not invent details. ${MATH_FORMATTING_INSTRUCTION}` },
    { role: "user" as const, content },
  ];
}

async function summarize(env: WorkerAnalysisEnvironment, job: AnalysisJob, analysis: D1AnalysisRepository, jobs: D1AnalysisJobRepository, source: ExtractedPaper, settings: AiSettings, waitUntil?: WaitUntil): Promise<void> {
  const selected = selectedLlm(env, settings, HOSTED_SUMMARY_MODEL);
  const startedAt = Date.now();
  try {
    const full = job.mode === "full";
    const summarySource = full ? excludeAppendixMaterial(source.text) : { text: source.text.slice(0, 18_000), excluded: false };
    let content: string;
    if (!full) {
      await jobs.updatePhase(job.id, "synthesizing");
      content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the supplied opening pages, explicitly state when information is insufficient, and do not imply that the omitted pages were reviewed. Do not add other top-level headings.\n\nOpening pages of the paper:\n${summarySource.text}`) });
    } else {
      const chunks = splitTextIntoPageChunks(summarySource.text, 4);
      if (!chunks.length) throw new Error("PDF_TEXT_EMPTY");
      await jobs.updatePhase(job.id, `digesting:${chunks.length}`);
      let completedChunks = 0;
      const digests = await mapWithConcurrency(chunks, SUMMARY_CHUNK_CONCURRENCY, async (chunk, index) => {
        const digest = await selected.client.complete({ model: selected.model, temperature: 0.2, maxOutputTokens: SUMMARY_DIGEST_MAX_OUTPUT_TOKENS, messages: messages(`Summarize the main things in source segment ${index + 1} of ${chunks.length}. Keep the important claims, methods, results, limitations, uncertainties, and section context. Be concise enough to fit within the response limit. Do not omit information because it is inconvenient, and do not invent details.\n\n${chunk}`) });
        completedChunks += 1;
        await jobs.updatePhase(job.id, `digesting:${completedChunks}:${chunks.length}`);
        return digest;
      });
      await jobs.updatePhase(job.id, "synthesizing");
      let current = digests;
      let reductionRounds = 0;
      while (current.join("\n\n").length > 20_000) {
        if (reductionRounds++ >= SUMMARY_MAX_REDUCTION_ROUNDS) throw new Error("SUMMARY_CONTEXT_TOO_LARGE");
        const batches: string[][] = [];
        let batch: string[] = [];
        for (const digest of current) {
          if (batch.length && `${batch.join("\n\n")}\n\n${digest}`.length > 20_000) { batches.push(batch); batch = []; }
          batch.push(digest);
        }
        if (batch.length) batches.push(batch);
        current = await Promise.all(batches.map((items) => selected.client.complete({ model: selected.model, temperature: 0.2, maxOutputTokens: SUMMARY_REDUCTION_MAX_OUTPUT_TOKENS, messages: messages(`Compress these paper digests into one complete, factual digest of no more than 6,000 characters. Retain all distinct findings, methods, limitations, and uncertainties; do not add information.\n\n${items.join("\n\n")}`) })));
      }
      content = await selected.client.complete({ model: selected.model, temperature: 0.2, maxOutputTokens: SUMMARY_FINAL_MAX_OUTPUT_TOKENS, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the complete paper and explicitly state when information is insufficient. Do not add other top-level headings.\n\n${current.join("\n\n")}`) });
    }
    if (!hasRequiredSummaryHeadings(content)) {
      await jobs.updatePhase(job.id, "formatting");
      content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Reformat the draft below into valid Markdown without losing information. Use exactly these headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Each heading must be a Markdown heading. Preserve all factual content and do not add other top-level headings. Draft:\n\n${content}`) });
    }
    if (!hasRequiredSummaryHeadings(content)) throw new Error("SUMMARY_FORMAT_INVALID");
    const fallbackQuickSummary = compactQuickSummary(content, 2);
    const summary: SummaryRecord = { paperId: job.paperId, content, quickSummary: fallbackQuickSummary, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "complete" };
    await analysis.saveSummary(summary);
    const refineQuickSummary = async () => {
      try {
        const quickSummary = await generateQuickSummary(selected.client, selected.model, content, 2);
        if (!quickSummary || quickSummary === fallbackQuickSummary) return;
        const latest = await analysis.getSummary(job.paperId);
        if (latest?.status === "complete" && latest.generatedAt === summary.generatedAt) await analysis.saveSummary({ ...summary, quickSummary });
      } catch {
        // The primary analysis is already saved; quick-summary refinement is best effort.
      }
    };
    if (waitUntil) waitUntil(refineQuickSummary());
    else await refineQuickSummary();
  } catch (error) {
    await analysis.saveSummary({ paperId: job.paperId, content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "error", errorMessage: errorMessage(error) });
    throw error;
  }
}

async function answerQuestion(env: WorkerAnalysisEnvironment, job: AnalysisJob, analysis: D1AnalysisRepository, source: ExtractedPaper, settings: AiSettings, waitUntil?: WaitUntil): Promise<void> {
  if (!job.questionId) throw new Error("QUESTION_NOT_FOUND");
  const question = (await analysis.listQuestions(job.paperId)).find((item) => item.id === job.questionId);
  if (!question) throw new Error("QUESTION_NOT_FOUND");
  const selected = selectedLlm(env, settings);
  const startedAt = Date.now();
  try {
    const jobs = new D1AnalysisJobRepository(env.DB);
    await jobs.updatePhase(job.id, "answering");
    const summary = await analysis.getSummary(job.paperId);
    const summaryContext = summary?.status === "complete" && summary.content ? `\n\nPaper summary:\n${summary.content}` : "";
    const answer = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: [{ role: "system", content: `Answer questions about a scientific paper accurately. Use only the supplied paper text and optional summary. Do not invent evidence. ${MATH_FORMATTING_INSTRUCTION}` }, { role: "user", content: `${question.prompt}${summaryContext}\n\nFull paper text:\n${source.text}` }] });
    const fallbackQuickSummary = compactQuickSummary(answer, 1);
    const record: QuestionAnswer = { content: answer, quickSummary: fallbackQuickSummary, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "complete" };
    await analysis.saveAnswer(job.paperId, question.id, record);
    const refineQuickSummary = async () => {
      try {
        const quickSummary = await generateQuickSummary(selected.client, selected.model, answer, 1);
        if (!quickSummary || quickSummary === fallbackQuickSummary) return;
        const latest = (await analysis.listQuestions(job.paperId)).find((item) => item.id === question.id)?.answer;
        if (latest?.status === "complete" && latest.generatedAt === record.generatedAt) await analysis.saveAnswer(job.paperId, question.id, { ...record, quickSummary });
      } catch {
        // The primary answer is already saved; quick-summary refinement is best effort.
      }
    };
    if (waitUntil) waitUntil(refineQuickSummary());
    else await refineQuickSummary();
  } catch (error) {
    await analysis.saveAnswer(job.paperId, question.id, { content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "error", errorMessage: errorMessage(error) });
    throw error;
  }
}

export async function executeAnalysisJob(env: WorkerAnalysisEnvironment, job: AnalysisJob, waitUntil?: WaitUntil): Promise<void> {
  const jobs = new D1AnalysisJobRepository(env.DB);
  const analysis = new D1AnalysisRepository(env.DB, () => hostedQuestionDefinitions);
  const paper = await new D1PaperRepository(env.DB).findById(job.paperId);
  if (!paper) throw new Error("PAPER_NOT_FOUND");
  await jobs.updatePhase(job.id, "extracting");
  const source = await extractPdf(env, paper, job.kind === "summary" && job.mode !== "full" ? "opening-pages" : "full", jobs, job.id);
  const settings = await analysis.getSettings();
  if (job.kind === "summary") await summarize(env, job, analysis, jobs, source, settings, waitUntil);
  else await answerQuestion(env, job, analysis, source, settings, waitUntil);
  await jobs.complete(job.id);
}
