CREATE TABLE IF NOT EXISTS app_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_summaries (
  paper_id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  source_pdf_sha256 TEXT,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_questions (
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  group_title TEXT NOT NULL,
  group_description TEXT NOT NULL,
  question_order INTEGER NOT NULL,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, question_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_question_answers (
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  source_pdf_sha256 TEXT,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, question_id),
  FOREIGN KEY (paper_id, question_id) REFERENCES paper_questions(paper_id, question_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_paper_questions_order ON paper_questions(paper_id, question_order);
