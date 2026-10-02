ALTER TABLE papers ADD COLUMN isbn TEXT;
CREATE INDEX IF NOT EXISTS idx_papers_isbn ON papers(isbn) WHERE isbn IS NOT NULL;
