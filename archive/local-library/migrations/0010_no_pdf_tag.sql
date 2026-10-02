INSERT OR IGNORE INTO tags (id, name, created_at)
VALUES ('system-no-pdf', 'no pdf', datetime('now'));

INSERT OR IGNORE INTO paper_tags (paper_id, tag_id)
SELECT papers.id, tags.id
FROM papers
JOIN tags ON tags.name = 'no pdf' COLLATE NOCASE
WHERE papers.r2_key IS NULL;

DELETE FROM paper_tags
WHERE tag_id IN (SELECT id FROM tags WHERE name = 'no pdf' COLLATE NOCASE)
  AND paper_id IN (SELECT id FROM papers WHERE r2_key IS NOT NULL);
