import type { PaperRecord, PaperMetadata, SortOrder } from "./types.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · Personal arXiv Paper Library</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <header class="site-header"><div class="shell"><a class="brand" href="/">Personal arXiv Paper Library</a><a class="button button-small" href="/add">+ Add paper</a></div></header>
  <main class="shell">${body}</main>
  <script src="/app.js" defer></script>
</body>
</html>`;
}

function tagLinks(tags: string[], selected?: string): string {
  return tags.map((tag) => `<a class="tag ${selected?.toLowerCase() === tag.toLowerCase() ? "tag-selected" : ""}" href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(" ");
}

function authorLine(authors: string[]): string {
  if (authors.length === 0) return "Author unknown";
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

function paperCard(paper: PaperRecord): string {
  return `<article class="paper-card">
    <div class="paper-card-main"><h2><a href="/papers/${encodeURIComponent(paper.id)}">${escapeHtml(paper.title)}</a></h2>
    <p class="muted">${escapeHtml(authorLine(paper.authors))} · ${escapeHtml(paper.year || paper.publishedDate?.slice(0, 4) || "Year unknown")}</p>
    <p class="paper-meta">${paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">arXiv:${escapeHtml(paper.arxivId)}</a>` : "Manual upload"} ${paper.r2Key ? "· PDF saved" : "· Metadata only"}</p></div>
    <div class="paper-tags">${tagLinks(paper.tags)}</div>
  </article>`;
}

export function renderLibrary(papers: PaperRecord[], tags: string[], query: { q?: string; tag?: string; sort?: SortOrder }): string {
  const sort = query.sort || "newest";
  const body = `<section class="page-heading"><div><p class="eyebrow">Research collection</p><h1>Your papers</h1><p class="muted">A private place to keep papers for later reading.</p></div><a class="button" href="/add">+ Add paper</a></section>
  <form class="toolbar" method="get" action="/">
    <label class="search-label"><span class="sr-only">Search papers</span><input name="q" value="${escapeHtml(query.q)}" placeholder="Search titles, authors, abstracts, tags…"></label>
    ${query.tag ? `<input type="hidden" name="tag" value="${escapeHtml(query.tag)}">` : ""}
    <select name="sort" aria-label="Sort papers"><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest added</option><option value="oldest" ${sort === "oldest" ? "selected" : ""}>Oldest added</option><option value="year-desc" ${sort === "year-desc" ? "selected" : ""}>Publication year ↓</option><option value="year-asc" ${sort === "year-asc" ? "selected" : ""}>Publication year ↑</option><option value="title" ${sort === "title" ? "selected" : ""}>Title A–Z</option></select>
    <button class="button button-secondary" type="submit">Search</button>
  </form>
  <section class="tag-bar"><span class="muted">Group by:</span> <a class="tag ${!query.tag ? "tag-selected" : ""}" href="/?${query.q ? `q=${encodeURIComponent(query.q)}&` : ""}sort=${sort}">All</a> ${tagLinks(tags, query.tag)}</section>
  <div class="results-heading"><span class="muted">${papers.length} paper${papers.length === 1 ? "" : "s"}</span>${query.tag ? `<a class="muted" href="/">Clear filters</a>` : ""}</div>
  <section class="paper-list">${papers.length ? papers.map(paperCard).join("\n") : `<div class="empty-state"><h2>No papers found</h2><p class="muted">Import an arXiv paper or upload a PDF to start your collection.</p><a class="button" href="/add">Add your first paper</a></div>`}</section>`;
  return layout("Library", body);
}

function field(label: string, name: string, value: unknown, options: { type?: string; placeholder?: string; rows?: number } = {}): string {
  const labelHtml = `<label>${escapeHtml(label)}`;
  if (options.rows) return `${labelHtml}<textarea name="${name}" rows="${options.rows}" placeholder="${escapeHtml(options.placeholder || "")}">${escapeHtml(value)}</textarea></label>`;
  return `${labelHtml}<input name="${name}" type="${options.type || "text"}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder || "")}"></label>`;
}

export function renderPaperForm(paper?: Partial<PaperRecord & PaperMetadata>, mode: "add" | "edit" = "add"): string {
  const isEdit = mode === "edit";
  const data = paper || { title: "", authors: [], categories: [], tags: [] };
  const fields = `${field("Title", "title", data.title, { placeholder: "Paper title" })}
    ${field("Authors", "authors", (data.authors || []).join("\n"), { rows: 3, placeholder: "One author per line" })}
    <div class="form-row">${field("Year", "year", data.year, { type: "number", placeholder: "2025" })}${field("Published date", "publishedDate", data.publishedDate, { placeholder: "2025-01-01" })}</div>
    ${field("Abstract", "abstract", data.abstract, { rows: 6 })}
    <div class="form-row">${field("Primary category", "primaryCategory", data.primaryCategory, { placeholder: "cs.AI" })}${field("Categories", "categories", (data.categories || []).join(", "), { placeholder: "cs.AI, cs.LG" })}</div>
    <div class="form-row">${field("Journal reference", "journalRef", data.journalRef)}${field("DOI", "doi", data.doi)}</div>
    <div class="form-row">${field("arXiv ID", "arxivId", data.arxivId, { placeholder: "2401.12345" })}${field("Source URL", "sourceUrl", data.sourceUrl)}</div>
    ${field("Tags", "tags", (data.tags || []).join(", "), { placeholder: "topic, project, method" })}`;
  return `<form class="paper-form" data-paper-form data-mode="${mode}" ${isEdit ? `data-paper-id="${escapeHtml(data.id)}"` : ""}>
    <div class="form-grid">${fields}</div>
    <input type="hidden" name="stagingToken" value="">
    <div class="form-actions"><button class="button" type="submit">${isEdit ? "Save changes" : "Save paper"}</button><a class="button button-secondary" href="${isEdit ? `/papers/${escapeHtml(data.id)}` : "/"}">Cancel</a><span class="form-status" role="status"></span></div>
  </form>`;
}

export function renderAddPage(): string {
  const body = `<section class="page-heading"><div><p class="eyebrow">New addition</p><h1>Add a paper</h1><p class="muted">Import from arXiv or upload a PDF you already have.</p></div></section>
  <section class="add-grid">
    <div class="panel"><h2>Import from arXiv</h2><p class="muted">Paste an arXiv ID, abstract URL, or PDF URL.</p><form data-arxiv-form><div class="inline-form"><input name="input" required placeholder="2401.12345 or https://arxiv.org/abs/…"><button class="button" type="submit">Import</button></div><p class="form-status" role="status"></p></form></div>
    <div class="panel"><h2>Upload a PDF</h2><p class="muted">Metadata can be entered after the file is staged.</p><form data-upload-form><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button" type="submit">Upload</button></div><p class="form-status" role="status"></p></form><hr><h2>Import a folder</h2><p class="muted">Create one editable paper record per PDF, using each filename as its initial title.</p><form data-bulk-upload-form><div class="inline-form"><input name="files" type="file" accept="application/pdf,.pdf" webkitdirectory multiple required><button class="button button-secondary" type="submit">Import folder</button></div><p class="form-status" role="status"></p><div class="bulk-results" data-bulk-results></div></form></div>
  </section>
  <section class="panel preview-panel" data-preview hidden><div class="preview-header"><div><p class="eyebrow">Review before saving</p><h2>Paper details</h2></div><span class="pdf-status" data-pdf-status></span></div><div data-preview-form>${renderPaperForm(undefined, "add")}</div><div class="warnings" data-warnings></div></section>`;
  return layout("Add paper", body);
}

export function renderPaperPage(paper: PaperRecord): string {
  const body = `<section class="page-heading"><div><a class="back-link" href="/">← Library</a><h1>${escapeHtml(paper.title)}</h1><p class="muted">${escapeHtml(authorLine(paper.authors))} · ${escapeHtml(paper.year || paper.publishedDate?.slice(0, 4) || "Year unknown")}</p></div><div class="page-actions"><a class="button button-secondary" href="/papers/${paper.id}/edit">Edit</a><button class="button button-danger" data-delete-paper="${paper.id}">Delete</button></div></section>
  <div class="detail-grid"><article class="panel paper-detail"><div class="detail-actions">${paper.r2Key ? `<a class="button" href="/api/papers/${paper.id}/pdf" target="_blank">Open PDF</a><a class="button button-secondary" href="/api/papers/${paper.id}/pdf?download=1">Download PDF</a>` : `<span class="muted">PDF not stored</span>`}</div><dl class="metadata"><dt>arXiv</dt><dd>${paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxivId)}</a>` : "—"}</dd><dt>Categories</dt><dd>${escapeHtml(paper.categories.join(", ") || "—")}</dd><dt>Journal reference</dt><dd>${escapeHtml(paper.journalRef || "—")}</dd><dt>DOI</dt><dd>${escapeHtml(paper.doi || "—")}</dd><dt>Added</dt><dd>${escapeHtml(new Date(paper.createdAt).toLocaleString())}</dd></dl><h2>Abstract</h2><p class="abstract">${escapeHtml(paper.abstract || "No abstract available.")}</p></article><aside class="panel"><h2>Tags</h2><div class="paper-tags large">${tagLinks(paper.tags)}</div><p class="muted">Edit the paper to change its grouping tags.</p></aside></div>`;
  return layout(paper.title, body);
}

export function renderEditPage(paper: PaperRecord): string {
  return layout(`Edit ${paper.title}`, `<section class="page-heading"><div><a class="back-link" href="/papers/${paper.id}">← Paper</a><p class="eyebrow">Edit metadata</p><h1>${escapeHtml(paper.title)}</h1></div></section><section class="panel">${renderPaperForm(paper, "edit")}<hr><h2>Replace PDF</h2><form data-replace-upload data-paper-id="${paper.id}"><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button button-secondary" type="submit">Stage replacement</button></div><p class="form-status" role="status"></p></form></section>`);
}
