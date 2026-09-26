import type Database from "better-sqlite3";
import * as crypto from "node:crypto";
import { questionDefinitions, type QuestionDefinition } from "../services/questions.js";
import { DEFAULT_CLASSIFICATION_SETTINGS, type ClassificationSettings } from "../services/tag-classification.js";

export type AiSettings = {
  provider: "openai" | "ollama";
  openaiModel: string;
  openaiEmbeddingModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbeddingModel: string;
};
export type SummaryRecord = { paperId: string; content: string; quickSummary?: string; provider: string; model: string; generatedAt: string; durationMs?: number; sourcePdfSha256?: string; promptVersion: string; status: "complete" | "stale" | "error"; errorMessage?: string };
export type QuestionAnswer = { content: string; quickSummary?: string; provider: string; model: string; generatedAt: string; durationMs?: number; sourcePdfSha256?: string; promptVersion: string; questionDefinitionHash?: string; status: "complete" | "stale" | "error"; errorMessage?: string };
export type StoredQuestion = QuestionDefinition & { paperId: string; isActive: boolean; answer?: QuestionAnswer };

const defaults: AiSettings = { provider: "openai", openaiModel: "gpt-5-nano", openaiEmbeddingModel: "text-embedding-3-small", ollamaBaseUrl: "http://localhost:11434", ollamaModel: "", ollamaEmbeddingModel: "nomic-embed-text" };

function ensureSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS paper_summaries (paper_id TEXT PRIMARY KEY, content TEXT NOT NULL DEFAULT '', quick_summary TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, generated_at TEXT NOT NULL, duration_ms INTEGER, source_pdf_sha256 TEXT, prompt_version TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'complete', error_message TEXT, updated_at TEXT NOT NULL, FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS paper_questions (paper_id TEXT NOT NULL, question_id TEXT NOT NULL, group_id TEXT NOT NULL, group_title TEXT NOT NULL, group_description TEXT NOT NULL, question_order INTEGER NOT NULL, label TEXT NOT NULL, prompt TEXT NOT NULL, definition_hash TEXT NOT NULL, is_custom INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, PRIMARY KEY (paper_id, question_id), FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS paper_question_answers (paper_id TEXT NOT NULL, question_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', quick_summary TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, generated_at TEXT NOT NULL, duration_ms INTEGER, source_pdf_sha256 TEXT, prompt_version TEXT NOT NULL, question_definition_hash TEXT, status TEXT NOT NULL DEFAULT 'complete', error_message TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (paper_id, question_id), FOREIGN KEY (paper_id, question_id) REFERENCES paper_questions(paper_id, question_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS idx_paper_questions_order ON paper_questions(paper_id, question_order);`);
  const columns = db.pragma("table_info(paper_questions)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "is_custom")) db.exec("ALTER TABLE paper_questions ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0");
  if (!columns.some((column) => column.name === "is_active")) db.exec("ALTER TABLE paper_questions ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1");
  const summaryColumns = db.pragma("table_info(paper_summaries)") as Array<{ name: string }>;
  if (!summaryColumns.some((column) => column.name === "duration_ms")) db.exec("ALTER TABLE paper_summaries ADD COLUMN duration_ms INTEGER");
  if (!summaryColumns.some((column) => column.name === "quick_summary")) db.exec("ALTER TABLE paper_summaries ADD COLUMN quick_summary TEXT");
  const answerColumns = db.pragma("table_info(paper_question_answers)") as Array<{ name: string }>;
  if (!answerColumns.some((column) => column.name === "duration_ms")) db.exec("ALTER TABLE paper_question_answers ADD COLUMN duration_ms INTEGER");
  if (!answerColumns.some((column) => column.name === "question_definition_hash")) db.exec("ALTER TABLE paper_question_answers ADD COLUMN question_definition_hash TEXT");
  if (!answerColumns.some((column) => column.name === "quick_summary")) db.exec("ALTER TABLE paper_question_answers ADD COLUMN quick_summary TEXT");
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

export class AnalysisRepository {
  constructor(private readonly db: Database.Database) {
    ensureSchema(db);
  }

  getSettings(): AiSettings {
    const rows = this.db.prepare("SELECT name, value FROM app_settings WHERE name IN ('ai.provider', 'ai.openaiModel', 'ai.openaiEmbeddingModel', 'ai.ollamaBaseUrl', 'ai.ollamaModel', 'ai.ollamaEmbeddingModel')").all() as Array<{ name: string; value: string }>;
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

  updateSettings(input: Partial<AiSettings>): AiSettings {
    const next = { ...this.getSettings(), ...input };
    const now = new Date().toISOString();
    const upsert = this.db.prepare("INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    this.db.transaction(() => {
      upsert.run("ai.provider", next.provider, now);
      upsert.run("ai.openaiModel", next.openaiModel, now);
      upsert.run("ai.openaiEmbeddingModel", next.openaiEmbeddingModel, now);
      upsert.run("ai.ollamaBaseUrl", next.ollamaBaseUrl, now);
      upsert.run("ai.ollamaModel", next.ollamaModel, now);
      upsert.run("ai.ollamaEmbeddingModel", next.ollamaEmbeddingModel, now);
    })();
    return next;
  }

  getClassificationSettings(): ClassificationSettings {
    const rows = this.db.prepare("SELECT name, value FROM app_settings WHERE name IN ('classification.model', 'classification.threshold')").all() as Array<{ name: string; value: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.name, row.value]));
    const threshold = Number(values["classification.threshold"]);
    return {
      model: values["classification.model"]?.trim() || DEFAULT_CLASSIFICATION_SETTINGS.model,
      threshold: Number.isFinite(threshold) && threshold >= 0.5 && threshold <= 1 ? threshold : DEFAULT_CLASSIFICATION_SETTINGS.threshold,
    };
  }

  updateClassificationSettings(input: Partial<ClassificationSettings>): ClassificationSettings {
    const next = { ...this.getClassificationSettings(), ...input };
    const now = new Date().toISOString();
    const upsert = this.db.prepare("INSERT INTO app_settings (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    this.db.transaction(() => {
      upsert.run("classification.model", next.model, now);
      upsert.run("classification.threshold", String(next.threshold), now);
    })();
    return next;
  }

  getSummary(paperId: string): SummaryRecord | null {
    const row = this.db.prepare("SELECT * FROM paper_summaries WHERE paper_id = ?").get(paperId) as Record<string, unknown> | undefined;
    return row ? { paperId, content: String(row.content), quickSummary: optional(row.quick_summary), provider: String(row.provider), model: String(row.model), generatedAt: String(row.generated_at), durationMs: row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms), sourcePdfSha256: optional(row.source_pdf_sha256), promptVersion: String(row.prompt_version), status: String(row.status) as SummaryRecord["status"], errorMessage: optional(row.error_message) } : null;
  }

  saveSummary(summary: SummaryRecord): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO paper_summaries (paper_id, content, quick_summary, provider, model, generated_at, duration_ms, source_pdf_sha256, prompt_version, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id) DO UPDATE SET content=excluded.content, quick_summary=excluded.quick_summary, provider=excluded.provider, model=excluded.model, generated_at=excluded.generated_at, duration_ms=excluded.duration_ms, source_pdf_sha256=excluded.source_pdf_sha256, prompt_version=excluded.prompt_version, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at`).run(summary.paperId, summary.content, summary.quickSummary || null, summary.provider, summary.model, summary.generatedAt, summary.durationMs ?? null, summary.sourcePdfSha256 || null, summary.promptVersion, summary.status, summary.errorMessage || null, now);
  }

  markFileChanged(paperId: string, sha256?: string): void {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE paper_summaries SET status = 'stale', updated_at = ?, error_message = NULL WHERE paper_id = ? AND (source_pdf_sha256 IS NOT ? OR source_pdf_sha256 IS NULL)").run(now, paperId, sha256 || null);
    this.db.prepare("UPDATE paper_question_answers SET status = 'stale', updated_at = ?, error_message = NULL WHERE paper_id = ? AND (source_pdf_sha256 IS NOT ? OR source_pdf_sha256 IS NULL)").run(now, paperId, sha256 || null);
  }

  ensureQuestions(paperId: string): void {
    const now = new Date().toISOString();
    const definitions = questionDefinitions();
    const statement = this.db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET group_id=excluded.group_id, group_title=excluded.group_title, group_description=excluded.group_description, question_order=excluded.question_order, label=excluded.label, prompt=excluded.prompt, definition_hash=excluded.definition_hash, is_active=1");
    const retire = this.db.prepare(`UPDATE paper_questions SET is_active = 0 WHERE paper_id = ? AND is_custom = 0 AND question_id NOT IN (${definitions.map(() => "?").join(", ")})`);
    this.db.transaction(() => {
      definitions.forEach((question) => statement.run(paperId, question.id, question.groupId, question.groupTitle, question.groupDescription, question.order, question.label, question.prompt, question.definitionHash, 0, now));
      retire.run(paperId, ...definitions.map((question) => question.id));
    })();
  }

  listQuestions(paperId: string, includeInactive = false): StoredQuestion[] {
    this.ensureQuestions(paperId);
    const rows = this.db.prepare("SELECT q.*, a.content AS answer_content, a.quick_summary AS answer_quick_summary, a.provider AS answer_provider, a.model AS answer_model, a.generated_at AS answer_generated_at, a.duration_ms AS answer_duration_ms, a.source_pdf_sha256 AS answer_source_pdf_sha256, a.prompt_version AS answer_prompt_version, a.question_definition_hash AS answer_question_definition_hash, a.status AS answer_status, a.error_message AS answer_error_message FROM paper_questions q LEFT JOIN paper_question_answers a ON a.paper_id = q.paper_id AND a.question_id = q.question_id WHERE q.paper_id = ? AND (? = 1 OR q.is_active = 1) ORDER BY q.question_order, q.created_at").all(paperId, includeInactive ? 1 : 0) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const questionDefinitionHash = optional(row.answer_question_definition_hash);
      const answerStatus = row.answer_status === null || row.answer_status === undefined ? undefined : String(row.answer_status) as QuestionAnswer["status"];
      const status = answerStatus && questionDefinitionHash !== String(row.definition_hash) ? "stale" : answerStatus;
      return { paperId, id: String(row.question_id), groupId: String(row.group_id), groupTitle: String(row.group_title), groupDescription: String(row.group_description), label: String(row.label), prompt: String(row.prompt), order: Number(row.question_order), definitionHash: String(row.definition_hash), isCustom: Boolean(row.is_custom), isActive: Boolean(row.is_active), answer: row.answer_content === null || row.answer_content === undefined ? undefined : { content: String(row.answer_content), quickSummary: optional(row.answer_quick_summary), provider: String(row.answer_provider), model: String(row.answer_model), generatedAt: String(row.answer_generated_at), durationMs: row.answer_duration_ms === null || row.answer_duration_ms === undefined ? undefined : Number(row.answer_duration_ms), sourcePdfSha256: optional(row.answer_source_pdf_sha256), promptVersion: String(row.answer_prompt_version), questionDefinitionHash, status: status || "stale", errorMessage: optional(row.answer_error_message) } };
    });
  }

  addQuestion(paperId: string, label: string, prompt: string): StoredQuestion {
    const cleanLabel = label.trim();
    const cleanPrompt = prompt.trim();
    if (!cleanLabel || !cleanPrompt) throw new Error("QUESTION_TEXT_REQUIRED");
    if (cleanLabel.length > 300 || cleanPrompt.length > 5000) throw new Error("QUESTION_TEXT_TOO_LONG");
    const id = `custom-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const definitionHash = crypto.createHash("sha256").update(`${id}\n${cleanLabel}\n${cleanPrompt}`).digest("hex");
    const count = Number((this.db.prepare("SELECT COUNT(*) AS count FROM paper_questions WHERE paper_id = ? AND is_custom = 1").get(paperId) as { count: number }).count);
    this.db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, 'custom', 'Open questions', 'Questions you add for this paper.', ?, ?, ?, ?, 1, 1, ?)").run(paperId, id, 10000 + count, cleanLabel, cleanPrompt, definitionHash, now);
    return this.listQuestions(paperId).find((question) => question.id === id)!;
  }

  saveQuestion(paperId: string, question: QuestionDefinition & { isActive?: boolean }): void {
    this.db.prepare("INSERT INTO paper_questions (paper_id, question_id, group_id, group_title, group_description, question_order, label, prompt, definition_hash, is_custom, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET group_id=excluded.group_id, group_title=excluded.group_title, group_description=excluded.group_description, question_order=excluded.question_order, label=excluded.label, prompt=excluded.prompt, definition_hash=excluded.definition_hash, is_custom=excluded.is_custom, is_active=excluded.is_active").run(paperId, question.id, question.groupId, question.groupTitle, question.groupDescription, question.order, question.label, question.prompt, question.definitionHash, question.isCustom ? 1 : 0, question.isActive === false ? 0 : 1, new Date().toISOString());
  }

  deleteQuestion(paperId: string, questionId: string): boolean {
    const result = this.db.prepare("DELETE FROM paper_questions WHERE paper_id = ? AND question_id = ? AND is_custom = 1").run(paperId, questionId);
    return result.changes > 0;
  }

  saveAnswer(paperId: string, questionId: string, answer: QuestionAnswer): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO paper_question_answers (paper_id, question_id, content, quick_summary, provider, model, generated_at, duration_ms, source_pdf_sha256, prompt_version, question_definition_hash, status, error_message, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(paper_id, question_id) DO UPDATE SET content=excluded.content, quick_summary=excluded.quick_summary, provider=excluded.provider, model=excluded.model, generated_at=excluded.generated_at, duration_ms=excluded.duration_ms, source_pdf_sha256=excluded.source_pdf_sha256, prompt_version=excluded.prompt_version, question_definition_hash=excluded.question_definition_hash, status=excluded.status, error_message=excluded.error_message, updated_at=excluded.updated_at`).run(paperId, questionId, answer.content, answer.quickSummary || null, answer.provider, answer.model, answer.generatedAt, answer.durationMs ?? null, answer.sourcePdfSha256 || null, answer.promptVersion, answer.questionDefinitionHash || null, answer.status, answer.errorMessage || null, now);
  }

}
