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

CREATE VIRTUAL TABLE IF NOT EXISTS paper_search_fts USING fts5(
  paper_id UNINDEXED,
  content
);

CREATE INDEX IF NOT EXISTS idx_paper_search_status ON paper_search_index(status);
