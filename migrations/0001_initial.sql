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
