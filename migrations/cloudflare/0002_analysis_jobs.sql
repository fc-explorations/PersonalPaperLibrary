CREATE TABLE IF NOT EXISTS analysis_jobs (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL,
  question_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('summary', 'question')),
  mode TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'error', 'cancelled')),
  phase TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_analysis_jobs_paper_created
  ON analysis_jobs(paper_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analysis_jobs_status
  ON analysis_jobs(status, updated_at);
