-- Cloud baseline for the final local schema represented by migrations 0001-0008.
-- Keep this migration independent from the local SQLite migration history.

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  arxiv_id TEXT,
  arxiv_base_id TEXT,
  title TEXT NOT NULL,
  abstract TEXT,
  published_date TEXT,
  updated_date TEXT,
  year INTEGER,
  primary_category TEXT,
  categories TEXT,
  journal_ref TEXT,
  accepted_venue TEXT,
  doi TEXT,
  source_url TEXT,
  arxiv_url TEXT,
  r2_key TEXT,
  pdf_sha256 TEXT,
  metadata_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_papers_arxiv_base_id
  ON papers(lower(arxiv_base_id))
  WHERE arxiv_base_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_created_at ON papers(created_at);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(year);
CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(title);

CREATE TABLE IF NOT EXISTS authors (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_authors (
  paper_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_order INTEGER NOT NULL,
  PRIMARY KEY (paper_id, author_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_authors_paper_order
  ON paper_authors(paper_id, author_order);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (paper_id, tag_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_tags_tag_paper
  ON paper_tags(tag_id, paper_id);

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
  duration_ms INTEGER,
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
  is_custom INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, question_id),
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_questions_order
  ON paper_questions(paper_id, question_order);

CREATE TABLE IF NOT EXISTS paper_question_answers (
  paper_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  duration_ms INTEGER,
  source_pdf_sha256 TEXT,
  prompt_version TEXT NOT NULL,
  question_definition_hash TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (paper_id, question_id),
  FOREIGN KEY (paper_id, question_id)
    REFERENCES paper_questions(paper_id, question_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS paper_search_index (
  paper_id TEXT PRIMARY KEY,
  search_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_json TEXT,
  embedding_provider TEXT,
  embedding_model TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_paper_search_status ON paper_search_index(status);

CREATE TABLE IF NOT EXISTS paper_abstract_extraction (
  paper_id TEXT PRIMARY KEY,
  error_message TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
);
