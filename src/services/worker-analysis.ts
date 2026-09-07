import { D1AnalysisJobRepository, type AnalysisJob } from "../repositories/d1-analysis-jobs.js";
import { D1AnalysisRepository } from "../repositories/d1-analysis.js";
import { D1PaperRepository } from "../repositories/d1-papers.js";
import type { D1Database } from "../cloudflare/d1.js";
import { OpenAiLlmClient, type LlmClient } from "./llm.js";
import { excludeAppendixMaterial, hasRequiredSummaryHeadings, splitTextIntoPageChunks, SUMMARY_HEADINGS, SUMMARY_PROMPT_VERSION, QUESTION_PROMPT_VERSION } from "./pdf-analysis-core.js";
import type { R2BucketLike } from "./r2-storage.js";
import type { AiSettings, QuestionAnswer, SummaryRecord } from "../repositories/analysis.js";

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "UNKNOWN_ERROR";
}

function selectedLlm(env: WorkerAnalysisEnvironment, settings: AiSettings): SelectedLlm {
  if (settings.provider !== "openai") throw new Error("OLLAMA_HOSTED_UNSUPPORTED");
  if (!env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_KEY_NOT_CONFIGURED");
  return {
    client: new OpenAiLlmClient({ openaiApiKey: async () => env.OPENAI_API_KEY, fetcher: fetch }),
    provider: "openai",
    model: settings.openaiModel,
  };
}

async function extractPdf(env: WorkerAnalysisEnvironment, paper: { id: string; r2Key?: string; pdfSha256?: string }): Promise<ExtractedPaper> {
  if (!env.AI) throw new Error("PDF_EXTRACTOR_UNAVAILABLE");
  if (!paper.r2Key) throw new Error("PDF_NOT_FOUND");
  const object = await env.PAPER_PDFS.get(paper.r2Key);
  if (!object) throw new Error("PDF_NOT_FOUND");
  const result = await env.AI.toMarkdown(
    { name: `${paper.id}.pdf`, blob: new Blob([await object.arrayBuffer()], { type: "application/pdf" }) },
    { conversionOptions: { output: { format: "text" }, pdf: { metadata: false } } },
  );
  if (result.format === "error" || !result.data?.trim()) throw new Error(result.error || "PDF_TEXT_EMPTY");
  return { text: result.data.trim(), sha256: paper.pdfSha256 };
}

function messages(content: string) {
  return [
    { role: "system" as const, content: "You summarize scientific papers accurately. Use only the supplied paper text, preserve uncertainty, and do not invent details." },
    { role: "user" as const, content },
  ];
}

async function summarize(env: WorkerAnalysisEnvironment, job: AnalysisJob, analysis: D1AnalysisRepository, jobs: D1AnalysisJobRepository, source: ExtractedPaper, settings: AiSettings): Promise<void> {
  const selected = selectedLlm(env, settings);
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
      const digests: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        digests.push(await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Summarize the main things in four-page chunk ${index + 1} of ${chunks.length}. Keep the important claims, methods, results, limitations, uncertainties, and section context. Do not omit information because it is inconvenient, and do not invent details.\n\n${chunk}`) }));
      }
      await jobs.updatePhase(job.id, "synthesizing");
      let digest = digests.join("\n\n");
      if (digest.length > 20_000) digest = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Compress these paper digests into one complete, factual digest of no more than 12,000 characters. Retain all distinct findings, methods, limitations, and uncertainties; do not add information.\n\n${digest.slice(0, 60_000)}`) });
      content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Write the final paper summary using exactly these seven Markdown headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Write each section as one or two concise prose paragraphs. Use bullets only when a genuinely short list is essential; do not turn every sentence or finding into a bullet. Cover the complete paper and explicitly state when information is insufficient. Do not add other top-level headings.\n\n${digest}`) });
    }
    if (!hasRequiredSummaryHeadings(content)) {
      await jobs.updatePhase(job.id, "formatting");
      content = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: messages(`Reformat the draft below into valid Markdown without losing information. Use exactly these headings, in this order: ${SUMMARY_HEADINGS.join(", ")}. Each heading must be a Markdown heading. Preserve all factual content and do not add other top-level headings. Draft:\n\n${content}`) });
    }
    if (!hasRequiredSummaryHeadings(content)) throw new Error("SUMMARY_FORMAT_INVALID");
    const summary: SummaryRecord = { paperId: job.paperId, content, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "complete" };
    await analysis.saveSummary(summary);
  } catch (error) {
    await analysis.saveSummary({ paperId: job.paperId, content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: SUMMARY_PROMPT_VERSION, status: "error", errorMessage: errorMessage(error) });
    throw error;
  }
}

async function answerQuestion(env: WorkerAnalysisEnvironment, job: AnalysisJob, analysis: D1AnalysisRepository, source: ExtractedPaper, settings: AiSettings): Promise<void> {
  if (!job.questionId) throw new Error("QUESTION_NOT_FOUND");
  const question = (await analysis.listQuestions(job.paperId)).find((item) => item.id === job.questionId);
  if (!question) throw new Error("QUESTION_NOT_FOUND");
  const selected = selectedLlm(env, settings);
  const startedAt = Date.now();
  try {
    const summary = await analysis.getSummary(job.paperId);
    const summaryContext = summary?.status === "complete" && summary.content ? `\n\nPaper summary:\n${summary.content}` : "";
    const answer = await selected.client.complete({ model: selected.model, temperature: 0.2, messages: [{ role: "system", content: "Answer questions about a scientific paper accurately. Use only the supplied paper text and optional summary. Do not invent evidence." }, { role: "user", content: `${question.prompt}${summaryContext}\n\nFull paper text:\n${source.text}` }] });
    const record: QuestionAnswer = { content: answer, provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "complete" };
    await analysis.saveAnswer(job.paperId, question.id, record);
  } catch (error) {
    await analysis.saveAnswer(job.paperId, question.id, { content: "", provider: selected.provider, model: selected.model, generatedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, sourcePdfSha256: source.sha256, promptVersion: QUESTION_PROMPT_VERSION, questionDefinitionHash: question.definitionHash, status: "error", errorMessage: errorMessage(error) });
    throw error;
  }
}

export async function executeAnalysisJob(env: WorkerAnalysisEnvironment, job: AnalysisJob): Promise<void> {
  const jobs = new D1AnalysisJobRepository(env.DB);
  const analysis = new D1AnalysisRepository(env.DB, () => []);
  const paper = await new D1PaperRepository(env.DB).findById(job.paperId);
  if (!paper) throw new Error("PAPER_NOT_FOUND");
  await jobs.updatePhase(job.id, "extracting");
  const source = await extractPdf(env, paper);
  const settings = await analysis.getSettings();
  if (job.kind === "summary") await summarize(env, job, analysis, jobs, source, settings);
  else await answerQuestion(env, job, analysis, source, settings);
  await jobs.complete(job.id);
}
