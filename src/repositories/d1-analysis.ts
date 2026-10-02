import type { AiSettings, QuestionAnswer, QuestionDefinition, StoredQuestion, SummaryRecord } from "../types.js";
import { all, batch, first, type D1Database, type D1Row } from "../cloudflare/d1.js";
import { DEFAULT_CLASSIFICATION_SETTINGS, type ClassificationSettings } from "../services/tag-classification.js";

export type D1QuestionCatalog = () => QuestionDefinition[];

const defaults: AiSettings = { provider: "openai", openaiModel: "gpt-5-nano", openaiEmbeddingModel: "text-embedding-3-small", ollamaBaseUrl: "http://localhost:11434", ollamaModel: "", ollamaEmbeddingModel: "nomic-embed-text" };

function optional(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

async function sha256Text(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class D1AnalysisRepository {
  constructor(private readonly db: D1Database, private readonly questionCatalog: D1QuestionCatalog) {}

  async getSettings(): Promise<AiSettings> {
    const rows = await all<{ name: string; value: string }>(this.db, "SELECT name, value FROM app_settings WHERE name IN ('ai.provider', 'ai.openaiModel', 'ai.openaiEmbeddingModel', 'ai.ollamaBaseUrl', 'ai.ollamaModel', 'ai.ollamaEmbeddingModel')");
    const values = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    return {
      provider: values["ai.provider"] === "ollama" ? "ollama" : defaults.provider,
      openaiModel: values["ai.openaiModel"] || defaults.openaiModel,
      openaiEmbeddingModel: values["ai.openaiEmbeddingModel"] || defaults.openaiEmbeddingModel,
      ollamaBaseUrl: values["ai.ollamaBaseUrl"] || defaults.ollamaBaseUrl,
      ollamaModel: values["ai.ollamaModel"] || defaults.ollamaModel,
      ollamaEmbeddingModel: values["ai.ollamaEmbeddingModel"] || defaults.ollamaEmbeddingModel,
    };
  }

  async updateSettings(input: Partial<AiSettings>): Promise<AiSettings> {
    const next = { ...(await this.getSettings()), ...input };
    const now = new Date().toISOString();
    await batch(this.db, [
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.provider", next.provider, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.openaiModel", next.openaiModel, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.openaiEmbeddingModel", next.openaiEmbeddingModel, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.ollamaBaseUrl", next.ollamaBaseUrl, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.ollamaModel", next.ollamaModel, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["ai.ollamaEmbeddingModel", next.ollamaEmbeddingModel, now] },
    ]);
    return next;
  }

  async getClassificationSettings(): Promise<ClassificationSettings> {
    const rows = await all<{ name: string; value: string }>(this.db, "SELECT name, value FROM app_settings WHERE name IN ('classification.model', 'classification.threshold')");
    const values = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    const threshold = Number(values["classification.threshold"]);
    return {
      model: values["classification.model"]?.trim() || DEFAULT_CLASSIFICATION_SETTINGS.model,
      threshold: Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1 ? threshold : DEFAULT_CLASSIFICATION_SETTINGS.threshold,
    };
  }

  async updateClassificationSettings(input: Partial<ClassificationSettings>): Promise<ClassificationSettings> {
    const next = { ...(await this.getClassificationSettings()), ...input };
    const now = new Date().toISOString();
    await batch(this.db, [
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["classification.model", next.model, now] },
      { query: "INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", values: ["classification.threshold", String(next.threshold), now] },
    ]);
    return next;
  }

  async getSummary(paperId: string): Promise<SummaryRecord | null> {
    const row = await first<D1Row>(this.db, "SELECT * FROM paper_summaries WHERE paper_id = ?", paperId);
    return row ? {
      paperId,
      content: String(row.content),
      quickSummary: optional(row.quick_summary),
      provider: String(row.provider),
      model: String(row.model),
      generatedAt: String(row.generated_at),
      durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
      sourcePdfSha256: optional(row.source_pdf_sha256),
      promptVersion: String(row.prompt_version),
      status: String(row.status) as SummaryRecord["status"],
      errorMessage: optional(row.error_message),
    } : null;
  }

  async listSummariesByPaper(): Promise<Map<string, SummaryRecord>> {
    const rows = await all<D1Row>(this.db, "SELECT * FROM paper_summaries");
    const summaries = new Map<string, SummaryRecord>();
    for (const row of rows) {
      const paperId = String(row.paper_id);
      summaries.set(paperId, {
        paperId,
        content: String(row.content),
        quickSummary: optional(row.quick_summary),
        provider: String(row.provider),
        model: String(row.model),
        generatedAt: String(row.generated_at),
        durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms),
        sourcePdfSha256: optional(row.source_pdf_sha256),
        promptVersion: String(row.prompt_version),
        status: String(row.status) as SummaryRecord["status"],
        errorMessage: optional(row.error_message),
      });
    }
    return summaries;
  }

  async saveSummary(summary: SummaryRecord): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare("INSERT INTO paper_summaries (paper_id, content, quick_summary, provider, model, generated_at, duration_ms, source_pdf_sha256, prompt_version, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET content=excluded.content, quick_summary=excluded.quick_summary, provider=excluded.provider, model=excluded.model, generated_at=excluded.generated_at, duration_ms=excluded.duration_ms, source_pdf_sha256=excluded.source_pdf_sha256, prompt_version=excluded.prompt_version, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at").bind(summary.paperId, summary.content, summary.quickSummary || null, summary.provider, summary.model, summary.generatedAt, summary.durationMs ?? null, summary.sourcePdfSha256 || null, summary.promptVersion, summary.status, summary.errorMessage || null, now).run();
  }

  async markFileChanged(paperId: string, sha256?: string): Promise<void> {
    const now = new Date().toISOString();
    await batch(this.db, [
      { query: "UPDATE paper_summaries SET status = 'stale', updated_at = ?, error_message = NULL WHERE paper_id = ? AND (source_pdf_sha256 IS NOT ? OR source_pdf_sha256 IS NULL)", values: [now, paperId, sha256 || null] },
      { query: "UPDATE paper_question_answers SET status = 'stale', updated_at = ?, error_message = NULL WHERE paper_id = ? AND (source_pdf_sha256 IS NOT ? OR source_pdf_sha256 IS NULL)", values: [now, paperId, sha256 || null] },
    ]);
  }

  async ensureQuestions(paperId: string): Promise<void> {
    const now = new Date().toISOString();
    const definitions = this.questionCatalog();
    const statements = definitions.map((question) => ({
      query: "INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET group_id=excluded.group_id, group_title=excluded.group_title, group_description=excluded.group_description, question_order=excluded.question_order, label=excluded.label, prompt=excluded.prompt, definition_hash=excluded.definition_hash, is_active=1",
      values: [paperId, question.id, question.groupId, question.groupTitle, question.groupDescription, question.order, question.label, question.prompt, question.definitionHash, now],
    }));
    const ids = definitions.map((question) => question.id);
    statements.push({
      query: ids.length ? `UPDATE paper_questions SET is_active = 0 WHERE paper_id = ? AND is_custom = 0 AND question_id NOT IN (${ids.map(() => "?").join(", ")})` : "UPDATE paper_questions SET is_active = 0 WHERE paper_id = ? AND is_custom = 0",
      values: [paperId, ...ids],
    });
    await batch(this.db, statements);
  }

  async listQuestions(paperId: string, includeInactive = false, syncCatalog = true): Promise<StoredQuestion[]> {
    if (syncCatalog) await this.ensureQuestions(paperId);
    const rows = await all<D1Row>(this.db, "SELECT q.*, a.content AS answer_content, a.quick_summary AS answer_quick_summary, a.provider AS answer_provider, a.model AS answer_model, a.generated_at AS answer_generated_at, a.duration_ms AS answer_duration_ms, a.source_pdf_sha256 AS answer_source_pdf_sha256, a.prompt_version AS answer_prompt_version, a.question_definition_hash AS answer_question_definition_hash, a.status AS answer_status, a.error_message AS answer_error_message FROM paper_questions q LEFT JOIN paper_question_answers a ON a.paper_id = q.paper_id AND a.question_id = q.question_id WHERE q.paper_id = ? AND (? = 1 OR q.is_active = 1) ORDER BY q.question_order, q.created_at", paperId, includeInactive ? 1 : 0);
    return rows.map((row) => {
      const questionDefinitionHash = optional(row.answer_question_definition_hash);
      const answerStatus = row.answer_status === null || row.answer_status === undefined ? undefined : String(row.answer_status) as QuestionAnswer["status"];
      const status = answerStatus && questionDefinitionHash !== String(row.definition_hash) ? "stale" : answerStatus;
      return {
        paperId,
        id: String(row.question_id),
        groupId: String(row.group_id),
        groupTitle: String(row.group_title),
        groupDescription: String(row.group_description),
        label: String(row.label),
        prompt: String(row.prompt),
        order: Number(row.question_order),
        definitionHash: String(row.definition_hash),
        isCustom: Boolean(row.is_custom),
        isActive: Boolean(row.is_active),
        answer: row.answer_content === null || row.answer_content === undefined ? undefined : {
          content: String(row.answer_content),
          quickSummary: optional(row.answer_quick_summary),
          provider: String(row.answer_provider),
          model: String(row.answer_model),
          generatedAt: String(row.answer_generated_at),
          durationMs: row.answer_duration_ms === null || row.answer_duration_ms === undefined ? undefined : Number(row.answer_duration_ms),
          sourcePdfSha256: optional(row.answer_source_pdf_sha256),
          promptVersion: String(row.answer_prompt_version),
          questionDefinitionHash,
          status: status || "stale",
          errorMessage: optional(row.answer_error_message),
        },
      };
    });
  }

  async listQuestionsByPaper(includeInactive = false): Promise<Map<string, StoredQuestion[]>> {
    const rows = await all<D1Row>(this.db, `SELECT q.*, a.content AS answer_content, a.quick_summary AS answer_quick_summary, a.provider AS answer_provider, a.model AS answer_model, a.generated_at AS answer_generated_at, a.duration_ms AS answer_duration_ms, a.source_pdf_sha256 AS answer_source_pdf_sha256, a.prompt_version AS answer_prompt_version, a.question_definition_hash AS answer_question_definition_hash, a.status AS answer_status, a.error_message AS answer_error_message FROM paper_questions q LEFT JOIN paper_question_answers a ON a.paper_id = q.paper_id AND a.question_id = q.question_id ${includeInactive ? "" : "WHERE q.is_active = 1"} ORDER BY q.paper_id, q.question_order, q.created_at`);
    const questions = new Map<string, StoredQuestion[]>();
    for (const row of rows) {
      const questionDefinitionHash = optional(row.answer_question_definition_hash);
      const answerStatus = row.answer_status === null || row.answer_status === undefined ? undefined : String(row.answer_status) as QuestionAnswer["status"];
      const status = answerStatus && questionDefinitionHash !== String(row.definition_hash) ? "stale" : answerStatus;
      const paperId = String(row.paper_id);
      const question: StoredQuestion = {
        paperId,
        id: String(row.question_id),
        groupId: String(row.group_id),
        groupTitle: String(row.group_title),
        groupDescription: String(row.group_description),
        label: String(row.label),
        prompt: String(row.prompt),
        order: Number(row.question_order),
        definitionHash: String(row.definition_hash),
        isCustom: Boolean(row.is_custom),
        isActive: Boolean(row.is_active),
        answer: row.answer_content === null || row.answer_content === undefined ? undefined : {
          content: String(row.answer_content),
          quickSummary: optional(row.answer_quick_summary),
          provider: String(row.answer_provider),
          model: String(row.answer_model),
          generatedAt: String(row.answer_generated_at),
          durationMs: row.answer_duration_ms === null || row.answer_duration_ms === undefined ? undefined : Number(row.answer_duration_ms),
          sourcePdfSha256: optional(row.answer_source_pdf_sha256),
          promptVersion: String(row.answer_prompt_version),
          questionDefinitionHash,
          status: status || "stale",
          errorMessage: optional(row.answer_error_message),
        },
      };
      questions.set(paperId, [...(questions.get(paperId) || []), question]);
    }
    return questions;
  }

  async addQuestion(paperId: string, label: string, prompt: string): Promise<StoredQuestion> {
    const cleanLabel = label.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanLabel || !cleanPrompt) throw new Error("QUESTION_TEXT_REQUIRED");
    if (cleanLabel.length > 300 || cleanPrompt.length > 5000) throw new Error("QUESTION_TEXT_TOO_LONG");
    const id = `custom-${globalThis.crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const definitionHash = await sha256Text(`${id}\n${cleanLabel}\n${cleanPrompt}`);
    const count = await first<{ count: number }>(this.db, "SELECT COUNT(*) AS count FROM paper_questions WHERE paper_id = ? AND is_custom = 1", paperId);
    await this.db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, 'custom', 'Open questions', 'Questions you add for this paper.', ?, ?, ?, ?, 1, 1, ?)").bind(paperId, id, 10000 + Number(count?.count || 0), cleanLabel, cleanPrompt, definitionHash, now).run();
    return (await this.listQuestions(paperId)).find((question) => question.id === id)!;
  }

  async saveQuestion(paperId: string, question: QuestionDefinition & { isActive?: boolean }): Promise<void> {
    await this.db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET group_id=excluded.group_id, group_title=excluded.group_title, group_description=excluded.group_description, question_order=excluded.question_order, label=excluded.label, prompt=excluded.prompt, definition_hash=excluded.definition_hash, is_custom=excluded.is_custom, is_active=excluded.is_active").bind(paperId, question.id, question.groupId, question.groupTitle, question.groupDescription, question.order, question.label, question.prompt, question.definitionHash, question.isCustom ? 1 : 0, question.isActive === false ? 0 : 1, new Date().toISOString()).run();
  }

  async deleteQuestion(paperId: string, questionId: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM paper_questions WHERE paper_id = ? AND question_id = ? AND is_custom = 1").bind(paperId, questionId).run();
    return Number(result.meta?.changes || 0) > 0;
  }

  async saveAnswer(paperId: string, questionId: string, answer: QuestionAnswer): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare("INSERT INTO paper_question_answers (paper_id, question_id, content, quick_summary, provider, model, generated_at, duration_ms, source_pdf_sha256, prompt_version, question_definition_hash, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET content=excluded.content, quick_summary=excluded.quick_summary, provider=excluded.provider, model=excluded.model, generated_at=excluded.generated_at, duration_ms=excluded.duration_ms, source_pdf_sha256=excluded.source_pdf_sha256, prompt_version=excluded.prompt_version, question_definition_hash=excluded.question_definition_hash, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at").bind(paperId, questionId, answer.content, answer.quickSummary || null, answer.provider, answer.model, answer.generatedAt, answer.durationMs ?? null, answer.sourcePdfSha256 || null, answer.promptVersion, answer.questionDefinitionHash || null, answer.status, answer.errorMessage || null, now).run();
  }
}
