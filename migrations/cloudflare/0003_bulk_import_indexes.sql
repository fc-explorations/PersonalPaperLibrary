-- Keep bulk-import duplicate checks index-backed so they do not scan the
-- entire papers table for every uploaded PDF.
CREATE INDEX IF NOT EXISTS idx_papers_source_url ON papers(source_url) WHERE source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi) WHERE doi IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_papers_pdf_sha256 ON papers(pdf_sha256) WHERE pdf_sha256 IS NOT NULL;
