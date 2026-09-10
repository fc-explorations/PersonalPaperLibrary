import { all, first, type D1Database, type D1Row } from "../cloudflare/d1.js";

export type AnalysisJobKind = "summary" | "question";
export type AnalysisJobStatus = "queued" | "running" | "complete" | "error" | "cancelled";

export type AnalysisJob = {
  id: string;
  paperId: string;
  questionId?: string;
  kind: AnalysisJobKind;
  mode?: string;
  status: AnalysisJobStatus;
  phase: string;
  attempts: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
};

function optional(value: unknown): string | undefined {
  return value === null || value === undefined || value === "" ? undefined : String(value);
}

function rowToJob(row: D1Row): AnalysisJob {
  return {
    id: String(row.id),
    paperId: String(row.paper_id),
    questionId: optional(row.question_id),
    kind: String(row.kind) as AnalysisJobKind,
    mode: optional(row.mode),
    status: String(row.status) as AnalysisJobStatus,
    phase: String(row.phase),
    attempts: Number(row.attempts || 0),
    errorCode: optional(row.error_code),
    errorMessage: optional(row.error_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    startedAt: optional(row.started_at),
    completedAt: optional(row.completed_at),
  };
}

export class D1AnalysisJobRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: { paperId: string; kind: AnalysisJobKind; questionId?: string; mode?: string }): Promise<AnalysisJob> {
    const id = globalThis.crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.prepare("INSERT INTO analysis_jobs (id, paper_id, question_id, kind, mode, status, phase, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', 'queued', 0, ?, ?)").bind(id, input.paperId, input.questionId || null, input.kind, input.mode || null, now, now).run();
    return (await this.get(id))!;
  }

  async get(id: string): Promise<AnalysisJob | null> {
    const row = await first<D1Row>(this.db, "SELECT * FROM analysis_jobs WHERE id = ?", id);
    return row ? rowToJob(row) : null;
  }

  async latestForPaper(paperId: string, kind?: AnalysisJobKind): Promise<AnalysisJob | null> {
    const row = await first<D1Row>(this.db, kind
      ? "SELECT * FROM analysis_jobs WHERE paper_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1"
      : "SELECT * FROM analysis_jobs WHERE paper_id = ? ORDER BY created_at DESC LIMIT 1", ...(kind ? [paperId, kind] : [paperId]));
    return row ? rowToJob(row) : null;
  }

  async latestForQuestion(paperId: string, questionId: string): Promise<AnalysisJob | null> {
    const row = await first<D1Row>(this.db, "SELECT * FROM analysis_jobs WHERE paper_id = ? AND kind = 'question' AND question_id = ? ORDER BY created_at DESC LIMIT 1", paperId, questionId);
    return row ? rowToJob(row) : null;
  }

  async activeForPaper(paperId: string, kind: AnalysisJobKind, mode?: string, questionId?: string): Promise<AnalysisJob | null> {
    const conditions = ["paper_id = ?", "kind = ?", "status IN ('queued', 'running')"];
    const values: unknown[] = [paperId, kind];
    if (mode) { conditions.push("mode = ?"); values.push(mode); }
    if (questionId) { conditions.push("question_id = ?"); values.push(questionId); }
    const row = await first<D1Row>(this.db, `SELECT * FROM analysis_jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT 1`, ...values);
    return row ? rowToJob(row) : null;
  }

  async listForPaper(paperId: string): Promise<AnalysisJob[]> {
    return (await all<D1Row>(this.db, "SELECT * FROM analysis_jobs WHERE paper_id = ? ORDER BY created_at DESC", paperId)).map(rowToJob);
  }

  async listActiveForPaper(paperId: string): Promise<AnalysisJob[]> {
    return (await all<D1Row>(this.db, "SELECT * FROM analysis_jobs WHERE paper_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC", paperId)).map(rowToJob);
  }

  async statusCounts(): Promise<{ queuedJobs: number; runningJobs: number; failedJobs: number }> {
    const rows = await all<{ status: string; count: number }>(this.db, "SELECT status, COUNT(*) AS count FROM analysis_jobs GROUP BY status");
    const counts = Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
    return { queuedJobs: counts.queued || 0, runningJobs: counts.running || 0, failedJobs: counts.error || 0 };
  }

  async claim(id: string): Promise<AnalysisJob | null> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE analysis_jobs SET status = 'running', phase = 'starting', attempts = attempts + 1, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status = 'queued'").bind(now, now, id).run();
    const job = await this.get(id);
    return job?.status === "running" ? job : null;
  }

  async updatePhase(id: string, phase: string): Promise<AnalysisJob | null> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE analysis_jobs SET phase = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(phase, now, id).run();
    return this.get(id);
  }

  async complete(id: string): Promise<AnalysisJob | null> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE analysis_jobs SET status = 'complete', phase = 'complete', updated_at = ?, completed_at = ? WHERE id = ? AND status = 'running'").bind(now, now, id).run();
    return this.get(id);
  }

  async fail(id: string, errorCode: string, errorMessage: string): Promise<AnalysisJob | null> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE analysis_jobs SET status = 'error', phase = 'failed', error_code = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')").bind(errorCode, errorMessage, now, now, id).run();
    return this.get(id);
  }

  async cancel(id: string): Promise<AnalysisJob | null> {
    const now = new Date().toISOString();
    await this.db.prepare("UPDATE analysis_jobs SET status = 'cancelled', phase = 'cancelled', updated_at = ?, completed_at = ? WHERE id = ? AND status IN ('queued', 'running')").bind(now, now, id).run();
    return this.get(id);
  }
}
