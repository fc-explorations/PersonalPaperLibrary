import type { PaperRecord, PaperMetadata, SortOrder } from "./types.js";
import type { SummaryRecord, StoredQuestion } from "./repositories/analysis.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function updateMathState(segment: string, initialState: boolean): boolean {
  let inMath = initialState;
  for (let index = 0; index < segment.length; index += 1) {
    if (segment.startsWith("$$", index)) {
      inMath = !inMath;
      index += 1;
    } else if (segment.startsWith("\\(", index) || segment.startsWith("\\[", index)) {
      inMath = true;
      index += 1;
    } else if (segment.startsWith("\\)", index) || segment.startsWith("\\]", index)) {
      inMath = false;
      index += 1;
    } else if (segment[index] === "$" && segment[index - 1] !== "\\") {
      inMath = !inMath;
    }
  }
  return inMath;
}

function urlAnchor(url: string): string {
  const trailing = url.match(/[.,;:!?)}\]]+$/)?.[0] || "";
  const target = trailing ? url.slice(0, -trailing.length) : url;
  return target ? `<a href="${target}" target="_blank" rel="noreferrer">${target}</a>${trailing}` : url;
}

function linkUrls(value: string): string {
  const urls = /https?:\/\/[^\s<>"']+/gi;
  let output = "";
  let cursor = 0;
  let inMath = false;
  let match: RegExpExecArray | null;
  while ((match = urls.exec(value))) {
    const plain = value.slice(cursor, match.index);
    output += plain;
    inMath = updateMathState(plain, inMath);
    output += inMath ? match[0] : urlAnchor(match[0]);
    cursor = urls.lastIndex;
  }
  return output + value.slice(cursor);
}

function renderText(value: unknown, autoLink = true): string {
  const escaped = escapeHtml(value);
  const bareTex = /\\(textit|emph|textbf|texttt|url)\{([^{}]*)\}/g;
  const fragments: string[] = [];
  let output = "";
  let cursor = 0;
  let inMath = false;
  let match: RegExpExecArray | null;
  while ((match = bareTex.exec(escaped))) {
    const plain = escaped.slice(cursor, match.index);
    output += plain;
    inMath = updateMathState(plain, inMath);
    const fragment = inMath ? match[0] : match[1] === "url" && autoLink ? urlAnchor(match[2]) : `\\(\\${match[1]}{${match[2]}}\\)`;
    const token = `\u0000${fragments.length}\u0000`;
    fragments.push(fragment);
    output += token;
    cursor = bareTex.lastIndex;
  }
  output += escaped.slice(cursor);
  const linked = autoLink ? linkUrls(output) : output;
  return linked.replace(/\u0000(\d+)\u0000/g, (_, index: string) => fragments[Number(index)]);
}

/** Render the small Markdown subset used by generated analysis without ever trusting raw HTML. */
export function renderMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] = [];
  let inCode = false;
  const inline = (text: string) => {
    const fragments: string[] = [];
    const protect = (fragment: string) => {
      const token = "\u0000" + fragments.length + "\u0000";
      fragments.push(fragment);
      return token;
    };
    let protectedText = text.replace(/`([^`]+)`/g, (_, code: string) => protect("<code>" + escapeHtml(code) + "</code>"));
    protectedText = protectedText.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)[^$\n]+?(?<!\\)\$)/g, (math: string) => protect(escapeHtml(math)));
    return escapeHtml(protectedText)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(/\u0000(\d+)\u0000/g, (_, index: string) => fragments[Number(index)]);
  };
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; } };
  const flushList = () => { if (list.length) { output.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`); list = []; } };
  const flushCode = () => { if (code.length) { output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = []; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flushParagraph(); flushList(); if (inCode) flushCode(); inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
    const item = line.match(/^\s*[-*+]\s+(.+)$/);
    if (item) { flushParagraph(); list.push(item[1]); continue; }
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (numbered) { flushParagraph(); list.push(numbered[1]); continue; }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList(); if (inCode) flushCode();
  return output.join("");
}

function layout(title: string, body: string, showHeader = true): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · PersonalPaperLibrary</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0,0" rel="stylesheet">
  <link rel="stylesheet" href="/styles.css">
  <script>window.MathJax = { tex: { inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]], displayMath: [["$$", "$$"], ["\\\\[", "\\\\]"]], macros: { textit: ["{\\\\mathit{#1}}", 1], emph: ["{\\\\mathit{#1}}", 1], textbf: ["{\\\\mathbf{#1}}", 1], texttt: ["{\\\\mathtt{#1}}", 1], url: ["{\\\\mathtt{#1}}", 1] } }, options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] } };</script>
  <script async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</head>
<body>
  ${showHeader ? `<header class="site-header"><div class="shell"><a class="brand" href="/" aria-label="PersonalPaperLibrary">${wordmark()}</a><div class="header-actions">${settingsLink()}</div></div></header>` : ""}
  <main class="shell">${body}</main>
  <script src="/app.js?v=11" defer></script>
</body>
</html>`;
}

function wordmark(): string {
  return `<span class="wordmark"><span>Personal</span><span class="wordmark-paper">Paper</span><span>Library</span></span>`;
}

function addAction(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">add</span><span>Add</span>`;
}

function addIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">add</span>`;
}

function libraryIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">arrow_back</span>`;
}

function settingsIcon(): string {
  return `<svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
}

function settingsLink(): string {
  return `<a class="settings-link" href="/settings" aria-label="Settings" title="Settings">${settingsIcon()}</a>`;
}

function pdfMissingIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">picture_as_pdf</span>`;
}

function editIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">edit</span>`;
}

function deleteIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">delete</span>`;
}

function openIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">open_in_new</span>`;
}

function goIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>`;
}

function downloadIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">download</span>`;
}

function saveIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">save</span>`;
}

function searchIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">search</span>`;
}

function closeIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">close</span>`;
}

function uploadIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">upload</span>`;
}

function folderIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">folder_open</span>`;
}

function copyIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">content_copy</span>`;
}

function analysisIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>`;
}

function refreshIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">refresh</span>`;
}

function expandIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">unfold_more</span>`;
}

function collapseIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_up</span>`;
}

function bibtexEscape(value: string): string {
  return value.replace(/([\\{}&%_$#])/g, "\\$1");
}

function bibtexKey(paper: PaperRecord): string {
  const surname = (paper.authors[0] || "paper").trim().split(/\s+/).pop()?.replace(/[^a-z0-9]/gi, "") || "paper";
  const year = paper.year || paper.publishedDate?.slice(0, 4) || "nd";
  const titleWord = paper.title.split(/\s+/).find((word) => /[a-z0-9]/i.test(word))?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "paper";
  return `${surname.toLowerCase()}${year}${titleWord}`;
}

function bibtexEntry(paper: PaperRecord): string {
  const fields: Array<[string, string]> = [
    ["title", paper.title],
    ["author", paper.authors.length ? paper.authors.join(" and ") : "Unknown author"],
    paper.year || paper.publishedDate?.slice(0, 4) ? ["year", String(paper.year || paper.publishedDate?.slice(0, 4))] : null,
    paper.journalRef ? ["journal", paper.journalRef] : null,
    paper.doi ? ["doi", paper.doi] : null,
    paper.arxivId ? ["eprint", paper.arxivId] : null,
    paper.arxivId ? ["archivePrefix", "arXiv"] : null,
    paper.sourceUrl || paper.arxivUrl ? ["url", paper.sourceUrl || paper.arxivUrl || ""] : null,
  ].filter((field): field is [string, string] => Boolean(field));
  const type = paper.journalRef ? "article" : "misc";
  return [`@${type}{${bibtexKey(paper)},`, ...fields.map(([name, value], index) => `  ${name} = {${bibtexEscape(value)}}${index === fields.length - 1 ? "" : ","}`), "}"].join("\n");
}

function tagLinks(tags: string[], selected?: string): string {
  return tags.map((tag) => `<a class="tag ${selected?.toLowerCase() === tag.toLowerCase() ? "tag-selected" : ""}" href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(tag)}</a>`).join(" ");
}

function libraryQuery(q: string | undefined, tags: string[], sort: SortOrder, all = false, untagged = false, page = 1, pageSize = 50): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  tags.forEach((tag) => params.append("tag", tag));
  params.set("sort", sort);
  if (all) params.set("all", "1");
  if (untagged) params.set("untagged", "1");
  if (pageSize !== 50) params.set("pageSize", String(pageSize));
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

function paginationPages(page: number, pageCount: number): Array<number | "ellipsis"> {
  if (pageCount <= 9) return Array.from({ length: pageCount }, (_, index) => index + 1);
  const visible = new Set([1, 2, page - 2, page - 1, page, page + 1, page + 2, pageCount - 1, pageCount]);
  const pages = [...visible].filter((pageNumber) => pageNumber >= 1 && pageNumber <= pageCount).sort((left, right) => left - right);
  const result: Array<number | "ellipsis"> = [];
  pages.forEach((pageNumber, index) => {
    if (index > 0 && pageNumber - pages[index - 1] > 1) result.push("ellipsis");
    result.push(pageNumber);
  });
  return result;
}

function groupTagLinks(tags: string[], selected: string[], q: string | undefined, sort: SortOrder, pageSize = 50): string {
  return tags.map((tag) => {
    const isSelected = selected.some((value) => value.toLowerCase() === tag.toLowerCase());
    const next = isSelected ? selected.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...selected, tag];
    return `<a class="tag ${isSelected ? "tag-selected" : ""}" href="/?${libraryQuery(q, next, sort, false, false, 1, pageSize)}" aria-pressed="${isSelected}">${escapeHtml(tag)}</a>`;
  }).join(" ");
}

function authorLine(authors: string[]): string {
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

function paperYear(paper: PaperRecord): string | undefined {
  return paper.year ? String(paper.year) : paper.publishedDate?.slice(0, 4) || undefined;
}

function paperSummary(paper: PaperRecord): string {
  return [paper.authors.length ? authorLine(paper.authors) : undefined, paperYear(paper)].filter(Boolean).join(" · ");
}

function paperWebResource(paper: Partial<PaperRecord & PaperMetadata>): string | undefined {
  if (paper.arxivUrl) return paper.arxivUrl;
  if (paper.doi) return `https://doi.org/${encodeURIComponent(paper.doi)}`;
  return paper.sourceUrl;
}

function metadataRow(label: string, value: unknown, content = renderText(value)): string {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return "";
  return `<dt>${escapeHtml(label)}</dt><dd>${content}</dd>`;
}

function paperCard(paper: PaperRecord): string {
  const summary = paperSummary(paper);
  return `<article class="paper-card">
    ${paper.r2Key ? "" : `<span class="pdf-badge pdf-missing-badge" title="PDF missing" aria-label="PDF missing">${pdfMissingIcon()}</span>`}
    <div class="paper-card-main"><h2><a href="/papers/${encodeURIComponent(paper.id)}">${renderText(paper.title, false)}</a></h2>
    ${summary ? `<p class="muted">${renderText(summary)}</p>` : ""}
    <p class="paper-meta">${paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">arXiv:${escapeHtml(paper.arxivId)}</a>` : "Manual upload"}${paper.journalRef ? ` · ${renderText(paper.journalRef)}` : ""}</p></div>
    ${paper.tags.length ? `<div class="paper-tags">${tagLinks(paper.tags)}</div>` : ""}
  </article>`;
}

export function renderLibrary(papers: PaperRecord[], tags: string[], query: { q?: string; tag?: string[]; sort?: SortOrder; all?: boolean; untagged?: boolean; page?: number; pageSize?: number; total?: number; storedPdfCount?: number }): string {
  const sort = query.sort || "newest";
  const page = query.page || 1;
  const pageSize = query.pageSize || 50;
  const total = query.total ?? papers.length;
  const selectedFilters = query.tag || [];
  const allSelected = Boolean(query.all);
  const untaggedSelected = Boolean(query.untagged);
  const downloadQuery = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize);
  const storedPdfCount = query.storedPdfCount ?? papers.filter((paper) => paper.r2Key).length;
  const hasSelection = Boolean(total && (query.q?.trim() || selectedFilters.length || allSelected || untaggedSelected));
  const selectedTags = [...new Set(papers.flatMap((paper) => paper.tags).map((tag) => tag.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const selectedTagOptions = selectedTags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(tag)}</option>`).join("");
  const selectionLabel = allSelected ? "Delete all" : untaggedSelected ? "Delete untagged" : query.q?.trim() || selectedFilters.length > 1 ? "Delete selected" : "Delete group";
  const selectionTags = escapeHtml(JSON.stringify(selectedFilters));
  const bulkButtons = hasSelection ? `<div class="bulk-actions" data-bulk-actions><button class="button button-secondary" type="button" data-toggle-bulk-tags aria-expanded="false">${editIcon()}<span>Edit tags</span></button>${storedPdfCount ? `<a class="button button-secondary" href="/api/export/pdfs?${downloadQuery}">${downloadIcon()}<span>Download ${storedPdfCount} PDF${storedPdfCount === 1 ? "" : "s"}</span></a>` : ""}<button class="button button-danger" type="button" data-delete-group data-delete-all="${allSelected}" data-delete-untagged="${untaggedSelected}" data-delete-query="${escapeHtml(query.q || "")}" data-delete-tags="${selectionTags}" data-delete-count="${total}">${deleteIcon()}<span>${selectionLabel}</span></button></div>` : "";
  const bulkTagEditor = hasSelection ? `<div class="bulk-tag-editor" data-bulk-tag-editor hidden><form data-bulk-tag-form data-selection-all="${allSelected}" data-selection-untagged="${untaggedSelected}" data-selection-query="${escapeHtml(query.q || "")}" data-selection-tags="${selectionTags}"><label>Tag to apply<div class="bulk-tag-fields"><select name="tag" data-bulk-tag-select required><option value="">Choose a tag…</option>${selectedTagOptions}<option value="__new__">New tag…</option></select><input name="newTag" data-new-tag placeholder="New tag name" hidden></div></label><div class="bulk-tag-actions"><button class="button button-secondary" type="submit" data-bulk-tag-action="add">${addIcon()}<span>Add tag</span></button><button class="button button-danger" type="submit" data-bulk-tag-action="remove">${deleteIcon()}<span>Remove tag</span></button><button class="button button-secondary" type="button" data-cancel-bulk-tags>${closeIcon()}<span>Cancel</span></button></div><p class="form-status" role="status"></p></form></div>` : "";
  const pageCount = Math.ceil(total / pageSize);
  const pageLinks = paginationPages(page, pageCount).map((pageNumber) => pageNumber === "ellipsis"
    ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>`
    : pageNumber === page
      ? `<span class="button button-secondary button-small page-number" aria-current="page">${pageNumber}</span>`
      : `<a class="button button-secondary button-small page-number" href="/?${libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, pageNumber, pageSize)}">${pageNumber}</a>`).join("");
  const firstPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize);
  const previousPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, page - 1, pageSize);
  const nextPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, page + 1, pageSize);
  const lastPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, pageCount, pageSize);
  const pagination = pageCount > 1 ? `<div class="pagination-footer"><span class="muted pagination-summary">Page ${page} of ${pageCount}</span><nav class="pagination" aria-label="Paper pages">${page > 1 ? `<a class="button button-secondary button-small" href="/?${firstPage}">First</a><a class="button button-secondary button-small" href="/?${previousPage}">Previous</a>` : `<span class="button button-secondary button-small pagination-disabled" aria-disabled="true">First</span><span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Previous</span>`}<span class="pagination-pages">${pageLinks}</span>${page < pageCount ? `<a class="button button-secondary button-small" href="/?${nextPage}">Next</a><a class="button button-secondary button-small" href="/?${lastPage}">Last</a>` : `<span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Next</span><span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Last</span>`}</nav></div>` : "";
  const body = `<div class="library-controls"><a class="button add-paper-button" href="/add" aria-label="Add paper" title="Add paper">${addAction()}</a><form class="toolbar" method="get" action="/">
    <label class="search-label"><span class="sr-only">Search papers</span><span class="search-input-wrap"><input name="q" value="${escapeHtml(query.q)}" placeholder="Search titles, authors, abstracts, tags…"><button class="clear-input" type="button" data-clear-search aria-label="Clear search" title="Clear search" hidden><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span></label>
    ${allSelected ? `<input type="hidden" name="all" value="1">` : ""}${untaggedSelected ? `<input type="hidden" name="untagged" value="1">` : ""}${selectedFilters.map((tag) => `<input type="hidden" name="tag" value="${escapeHtml(tag)}">`).join("")}<input type="hidden" name="pageSize" value="${pageSize}">
    <select name="sort" aria-label="Sort papers"><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest added</option><option value="oldest" ${sort === "oldest" ? "selected" : ""}>Oldest added</option><option value="year-desc" ${sort === "year-desc" ? "selected" : ""}>Publication year ↓</option><option value="year-asc" ${sort === "year-asc" ? "selected" : ""}>Publication year ↑</option><option value="title" ${sort === "title" ? "selected" : ""}>Title A–Z</option></select>
    <button class="button button-secondary" type="submit">${searchIcon()}<span>Search</span></button>
  </form></div>
  <section class="tag-bar" data-library-page-size="${pageSize}"><span class="muted">Group by:</span> <a class="tag ${allSelected ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, [], sort, !allSelected, false, 1, pageSize)}" aria-pressed="${allSelected}">All</a> <a class="tag ${untaggedSelected ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, [], sort, false, !untaggedSelected, 1, pageSize)}" aria-pressed="${untaggedSelected}">NaN</a> ${groupTagLinks(tags, allSelected || untaggedSelected ? [] : selectedFilters, query.q, sort, pageSize)}</section>
  <div class="results-heading"><span class="muted">${total} paper${total === 1 ? "" : "s"}</span><div class="results-actions">${bulkButtons}${bulkTagEditor}</div></div>
  <section class="paper-list${bulkButtons ? " has-bulk-actions" : ""}${papers.length ? "" : " empty-paper-list"}">${papers.length ? papers.map(paperCard).join("\n") : `<div class="empty-state"><h2>No papers found</h2><p class="muted">Add a paper or upload a PDF to start your collection.</p><a class="button" href="/add">Add your first paper</a></div>`}</section>${pagination}`;
  return layout("Library", body);
}

function field(label: string, name: string, value: unknown, options: { type?: string; placeholder?: string; rows?: number } = {}): string {
  const labelHtml = `<label>${escapeHtml(label)}`;
  if (options.rows) return `${labelHtml}<textarea name="${name}" rows="${options.rows}" placeholder="${escapeHtml(options.placeholder || "")}">${escapeHtml(value)}</textarea></label>`;
  return `${labelHtml}<input name="${name}" type="${options.type || "text"}" value="${escapeHtml(value)}" placeholder="${escapeHtml(options.placeholder || "")}"></label>`;
}

function sourceUrlField(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  const validUrl = /^https?:\/\//i.test(url);
  return `<label>Source URL<div class="field-with-action"><input name="sourceUrl" type="text" value="${escapeHtml(value)}"><a class="button button-secondary button-small" data-source-url-go href="${validUrl ? escapeHtml(url) : "#"}" target="_blank" rel="noreferrer"${validUrl ? "" : " hidden"}>${goIcon()}<span>Go</span></a></div></label>`;
}

function formActions(data: Partial<PaperRecord & PaperMetadata>, isEdit: boolean, formId: string): string {
  const webResourceUrl = !data.r2Key ? paperWebResource(data) : undefined;
  const webResourceButton = `<a class="button button-secondary" data-web-resource data-web-resource-for="${escapeHtml(formId)}"${webResourceUrl ? ` href="${escapeHtml(webResourceUrl)}"` : ""} target="_blank" rel="noreferrer"${webResourceUrl ? "" : " hidden"}>${openIcon()}<span>Open web resource</span></a>`;
  const cancelButton = isEdit ? "" : `<a class="button button-secondary" href="/">${closeIcon()}<span>Cancel</span></a>`;
  return `<div class="form-actions"><div class="form-actions-row"><div class="form-actions-left"><button class="button button-secondary" type="button" form="${escapeHtml(formId)}" data-lookup-metadata>${searchIcon()}<span>Find metadata</span></button>${webResourceButton}</div><div class="form-actions-right"><button class="button" type="submit" form="${escapeHtml(formId)}">${saveIcon()}<span>${isEdit ? "Save changes" : "Save paper"}</span></button>${cancelButton}</div></div><span class="form-status" data-form-status-for="${escapeHtml(formId)}" role="status"></span></div>`;
}

export function renderPaperForm(paper?: Partial<PaperRecord & PaperMetadata>, mode: "add" | "edit" = "add", actionsOutside = false): string {
  const isEdit = mode === "edit";
  const data = paper || { title: "", authors: [], categories: [], tags: [] };
  const formId = isEdit ? `paper-form-${data.id}` : "paper-form-new";
  const authorCount = (data.authors || []).length;
  const authorRows = Math.max(3, Math.min(authorCount || 3, 10));
  const openPdfUrl = isEdit && data.r2Key ? `/api/papers/${escapeHtml(data.id)}/pdf` : "";
  const openPdfButton = `<a class="button button-secondary button-small" data-paper-pdf-link${openPdfUrl ? ` href="${openPdfUrl}"` : ""} target="_blank" rel="noreferrer" aria-label="Open PDF" title="Open PDF"${openPdfUrl ? "" : " hidden"}>${openIcon()}<span>Open</span></a>`;
  const titleField = `<label>Title<div class="field-with-action title-field"><input name="title" type="text" value="${escapeHtml(data.title)}" placeholder="Paper title">${openPdfButton}</div></label>`;
  const tagsField = `<div class="tag-field"><label>Tags<input name="tags" type="text" value="${escapeHtml((data.tags || []).join(", "))}" placeholder="topic, project, method"></label><button class="button button-secondary button-small" type="button" data-suggest-tags>${analysisIcon()}<span>Suggest tags</span></button><div class="tag-suggestions" data-tag-suggestions hidden><div class="tag-suggestions-heading"><strong>Suggested tags</strong><span class="muted" data-tag-suggestions-status></span></div><div class="tag-suggestion-list" data-tag-suggestion-list></div><button class="button button-secondary button-small" type="button" data-apply-tag-suggestions>Add selected tags</button></div></div>`;
  const fields = `${titleField}
    ${field("Authors", "authors", (data.authors || []).join("\n"), { rows: authorRows, placeholder: "One author per line" })}
    <div class="form-row">${field("Year", "year", data.year, { type: "number", placeholder: "2025" })}${field("Published date", "publishedDate", data.publishedDate, { placeholder: "2025-01-01" })}</div>
    ${field("Abstract", "abstract", data.abstract, { rows: 6 })}
    <div class="form-row">${field("Primary category", "primaryCategory", data.primaryCategory, { placeholder: "cs.AI" })}${field("Categories", "categories", (data.categories || []).join(", "), { placeholder: "cs.AI, cs.LG" })}</div>
    <div class="form-row">${field("Journal reference", "journalRef", data.journalRef)}${field("DOI", "doi", data.doi)}</div>
    <div class="form-row">${field("arXiv ID", "arxivId", data.arxivId, { placeholder: "2401.12345" })}${sourceUrlField(data.sourceUrl)}</div>
    ${tagsField}`;
  const actions = formActions(data, isEdit, formId);
  return `<form id="${escapeHtml(formId)}" class="paper-form" data-paper-form data-mode="${mode}" ${isEdit ? `data-paper-id="${escapeHtml(data.id)}"` : ""}>
    <div class="form-grid">${fields}</div>
    <input type="hidden" name="stagingToken" value="">
    ${actionsOutside ? "" : actions}
  </form>`;
}

export function renderAddPage(): string {
  const body = `<section class="add-grid add-options">
    <div class="panel"><h2>Find a paper</h2><p class="muted">Enter a title, DOI, URL, or identifier.</p><form data-import-form><div class="inline-form"><input name="input" required placeholder="Paper title, DOI, or URL"><button class="button" type="submit">${searchIcon()}<span>Find</span></button></div><p class="form-status" role="status"></p></form></div>
    <div class="add-file-options"><div class="panel"><h2>Upload a PDF</h2><p class="muted">Metadata can be entered after the file is staged.</p><form data-upload-form><div class="inline-form"><div class="file-picker"><label class="button button-secondary" for="single-pdf-input">${uploadIcon()}<span>Choose file</span></label><input id="single-pdf-input" name="file" type="file" accept="application/pdf,.pdf" required class="sr-only" data-single-pdf-input></div></div><p class="form-status" role="status"></p></form></div>
    <div class="panel"><h2>Import a folder</h2><p class="muted">Create one editable paper record per PDF, using each filename as its initial title. The folder name is added as a tag.</p><form data-bulk-upload-form><div class="inline-form"><div class="file-picker"><label class="button button-secondary" for="folder-pdf-input">${folderIcon()}<span>Choose folder</span></label><input id="folder-pdf-input" name="files" type="file" accept="application/pdf,.pdf" webkitdirectory multiple required class="sr-only" data-folder-pdf-input></div></div><p class="form-status" role="status"></p><div class="bulk-results" data-bulk-results></div></form></div></div>
  </section>
  <section class="panel preview-panel" data-preview hidden><div class="preview-header"><div><p class="eyebrow">Review before saving</p><h2>Paper details</h2></div><div class="preview-actions"><span class="pdf-status" data-pdf-status></span></div></div><div data-preview-form>${renderPaperForm(undefined, "add")}</div><div class="warnings" data-warnings></div></section>`;
  return layout("Add paper", body);
}

function analysisMeta(provider: string, model: string, generatedAt: string, durationMs?: number, className = "analysis-meta"): string {
  const duration = durationMs === undefined ? "" : ` · ${Math.floor(durationMs / 60000)}:${String(Math.floor(durationMs / 1000) % 60).padStart(2, "0")}`;
  return `<p class="${className} muted">${escapeHtml(provider)} · ${escapeHtml(model)} · ${escapeHtml(new Date(generatedAt).toLocaleString("en-GB"))}${duration}</p>`;
}

function renderSummarySection(summary?: SummaryRecord | null): string {
  const state = summary?.status === "stale" ? `<p class="status-warning">The stored summary is stale because the PDF changed. Regenerate it.</p>` : summary?.status === "error" ? `<p class="status-error">Summary generation failed: ${escapeHtml(summary.errorMessage || "Unknown error")}</p>` : "";
  const content = summary?.status === "complete" && summary.content ? `<div class="analysis-content">${renderMarkdown(summary.content.replace(/(^|\n)(\s*(?:[-*+]\s+|\d+[.)]\s+)[^\n]+(?:\n|$))+/g, (_, prefix: string, block: string) => `${prefix}${block.split(/\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean).join(" ")}\n`))}</div>` : "";
  const button = summary?.status === "complete" ? `<button class="button button-secondary button-small" type="button" data-regenerate-summary>${refreshIcon()}<span>Regenerate summary</span></button>` : `<button class="button button-secondary" type="button" data-generate-summary>${analysisIcon()}<span>Generate summary</span></button>`;
  const summaryComplete = summary?.status === "complete";
  return `<details class="detail-section analysis-section" data-summary-section><summary><span>Paper summary</span><span class="analysis-progress-dot${summaryComplete ? " is-complete" : ""}" aria-label="${summaryComplete ? "Summary available" : "Summary not generated"}" title="${summaryComplete ? "Summary available" : "Summary not generated"}"></span></summary><div class="analysis-body">${state}${content}${summary ? analysisMeta(summary.provider, summary.model, summary.generatedAt, summary.durationMs) : ""}<div class="analysis-actions">${button}<span class="form-status" data-summary-status role="status"></span></div></div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse paper summary" title="Collapse paper summary">${collapseIcon()}</button></div></details>`;
}

function renderQuestionsSection(questions: StoredQuestion[]): string {
  const groups = new Map<string, StoredQuestion[]>();
  questions.forEach((question) => groups.set(question.groupId, [...(groups.get(question.groupId) || []), question]));
  const groupSections = [...groups.entries()].map(([groupId, items]) => {
    const answered = items.filter((question) => question.answer?.status === "complete").length;
    const progress = items.map((question) => `<span class="question-progress-dot${question.answer?.status === "complete" ? " is-answered" : ""}" aria-hidden="true"></span>`).join("");
    return `<details class="question-group" data-question-group="${escapeHtml(groupId)}"><summary><span class="question-group-label">${escapeHtml(items[0].groupTitle)}</span><span class="question-progress" aria-label="${answered} of ${items.length} questions answered" title="${answered} of ${items.length} questions answered">${progress}</span></summary><div class="question-group-body"><p class="muted">${escapeHtml(items[0].groupDescription)}</p>${items.map((question) => `<article class="question-item" data-question-id="${escapeHtml(question.id)}"><h3>${escapeHtml(question.label)}</h3>${question.answer?.status === "complete" ? `<div class="analysis-content question-answer">${renderMarkdown(question.answer.content)}</div>${analysisMeta(question.answer.provider, question.answer.model, question.answer.generatedAt, question.answer.durationMs, "analysis-meta question-answer-meta")}` : question.answer?.status === "error" ? `<p class="status-error">Answer generation failed: ${escapeHtml(question.answer.errorMessage || "Unknown error")}</p>` : question.answer?.status === "stale" ? `<p class="status-warning">This answer is stale because the PDF changed.</p>` : `<p class="muted question-empty">Not answered yet.</p>`}<div class="question-actions"><button class="button button-secondary button-small" type="button" data-generate-question="${escapeHtml(question.id)}">${question.answer ? refreshIcon() : analysisIcon()}<span>${question.answer ? "Regenerate answer" : "Generate answer"}</span></button>${question.isCustom ? `<button class="button button-danger button-small" type="button" data-delete-question="${escapeHtml(question.id)}">${deleteIcon()}<span>Delete</span></button>` : ""}<span class="form-status" data-question-status role="status"></span></div></article>`).join("")}</div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse ${escapeHtml(items[0].groupTitle)} questions" title="Collapse ${escapeHtml(items[0].groupTitle)} questions">${collapseIcon()}</button></div></details>`;
  }).join("");
  const addQuestion = `<details class="add-question-form"><summary>Add new question</summary><div class="add-question-body"><p class="muted">Ask an additional open question about this paper. It will be saved for this paper.</p><form data-add-question><label>Question<textarea name="question" required maxlength="5000" rows="3" placeholder="What else would you like to know?"></textarea></label><button class="button button-secondary" type="submit">${analysisIcon()}<span>Add question</span></button><p class="form-status" role="status"></p></form><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse add new question" title="Collapse add new question">${collapseIcon()}</button></div></div></details>`;
  return `<section class="detail-section analysis-questions" data-questions-section><div class="section-heading"><h2>Paper questions</h2><div class="question-section-actions"><button class="icon-button" type="button" data-toggle-questions aria-label="Expand all questions" title="Expand all questions">${expandIcon()}</button><button class="button button-secondary button-small" type="button" data-generate-all-questions>${analysisIcon()}<span>Generate all answers</span></button></div></div><p class="form-status" data-questions-status role="status"></p>${groupSections}${addQuestion}</section>`;
}

export function renderPaperPage(paper: PaperRecord, summary?: SummaryRecord | null, questions: StoredQuestion[] = []): string {
  const paperLine = paperSummary(paper);
  const bibtex = bibtexEntry(paper);
  const bibtexRows = Math.max(3, bibtex.split(/\r?\n/).length);
  const metadata = [
    metadataRow("Authors", paper.authors.join(", ")),
    metadataRow("Year", paperYear(paper)),
    metadataRow("arXiv", paper.arxivId, paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxivId)}</a>` : ""),
    metadataRow("Categories", paper.categories.join(", ")),
    metadataRow("Journal reference", paper.journalRef),
    metadataRow("DOI", paper.doi),
    metadataRow("Document", paper.r2Key ? "PDF" : "Not stored", paper.r2Key ? `<a href="/api/papers/${escapeHtml(paper.id)}/pdf" target="_blank" rel="noreferrer">PDF</a>` : `<span class="muted">Not stored</span>`),
    metadataRow("Added", new Date(paper.createdAt).toLocaleString("en-GB")),
  ].join("");
  const abstractSection = paper.abstract?.trim() ? `<section class="detail-section abstract-section"><h2>Abstract</h2><p class="abstract">${renderText(paper.abstract)}</p></section>` : "";
  const tagsSection = paper.tags.length ? `<section class="detail-section detail-tags"><h2>Tags</h2><div class="paper-tags large">${tagLinks(paper.tags)}</div></section>` : "";
  const body = `<section class="page-heading paper-heading"><h1>Paper</h1><div class="page-actions"><a class="icon-button" href="/papers/${paper.id}/edit" aria-label="Edit paper" title="Edit paper">${editIcon()}<span>Edit</span></a><button class="icon-button icon-button-danger" data-delete-paper="${paper.id}" aria-label="Delete paper" title="Delete paper">${deleteIcon()}<span>Del</span></button></div></section>
  <article class="panel paper-detail" data-paper-id="${escapeHtml(paper.id)}"><div class="detail-content"><header class="paper-detail-heading"><h1>${renderText(paper.title)}</h1>${paperLine ? `<p class="muted">${renderText(paperLine)}</p>` : ""}</header>${abstractSection}<section class="detail-section metadata-panel" aria-label="Paper information"><h2 class="detail-subheading">Paper information</h2><dl class="metadata">${metadata}</dl></section>${tagsSection}${renderSummarySection(summary)}${renderQuestionsSection(questions)}<details class="detail-section bibtex-section"><summary>BibTeX</summary><div class="bibtex-body"><div class="bibtex-heading"><p class="eyebrow">Citation entry</p><button class="button button-secondary" type="button" data-copy-bibtex>${copyIcon()}<span>Copy</span></button></div><textarea class="bibtex-text" data-bibtex readonly rows="${bibtexRows}" aria-label="BibTeX entry">${escapeHtml(bibtex)}</textarea><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse BibTeX" title="Collapse BibTeX">${collapseIcon()}</button></div></div></details></div></article>`;
  return layout(paper.title, body);
}

export function renderEditPage(paper: PaperRecord): string {
  const formId = `paper-form-${paper.id}`;
  return layout(`Edit ${paper.title}`, `<div class="edit-page"><section class="page-heading edit-heading"><h1>Edit metadata</h1><div class="edit-actions-top">${formActions(paper, true, formId)}</div></section><section class="panel edit-panel">${renderPaperForm(paper, "edit", true)}<hr><h2>Replace PDF</h2><form data-replace-upload data-paper-id="${paper.id}"><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button button-secondary" type="submit">${uploadIcon()}<span>Replace</span></button></div><p class="form-status" role="status"></p></form></section></div>`);
}

function themeOption(group: "accent" | "background", value: string, label: string, color: string): string {
  return `<label class="theme-option"><input type="radio" name="${group}" value="${value}" data-theme-setting="${group}"><span class="theme-swatch" style="--swatch: ${color}"></span><span>${label}</span></label>`;
}

function customThemeOption(group: "accent" | "background", color: string): string {
  return `<label class="theme-option theme-option-custom"><input type="radio" name="${group}" value="custom" data-theme-setting="${group}"><input class="theme-picker" type="color" value="${color}" data-theme-picker="${group}" aria-label="Choose custom ${group} color"><span>Custom</span></label>`;
}

function widthOption(value: string): string {
  return `<label class="width-option"><input type="radio" name="contentWidth" value="${value}" data-theme-setting="contentWidth"><span>${value}%</span></label>`;
}

function pageSizeOption(value: string): string {
  return `<label class="width-option"><input type="radio" name="pageSize" value="${value}" data-theme-setting="pageSize"><span>${value}</span></label>`;
}

function derivedColorPreview(): string {
  return `<div class="derived-color-preview" data-derived-color-preview aria-live="polite"><p class="derived-color-preview-title">Derived section colors</p><p class="muted">These update automatically with the selected background.</p><div class="derived-color-options"><div class="derived-color-option"><span class="derived-color-swatch" data-derived-color-swatch="sectionColor"></span><span><strong>Section headings</strong><code data-derived-color-value="sectionColor">#726e65</code></span></div><div class="derived-color-option"><span class="derived-color-swatch" data-derived-color-swatch="sectionSurface"></span><span><strong>Question surfaces</strong><code data-derived-color-value="sectionSurface">#faf9f7</code></span></div><div class="derived-color-option"><span class="derived-color-swatch derived-color-swatch-border" data-derived-color-swatch="sectionBorder"></span><span><strong>Dividers and borders</strong><code data-derived-color-value="sectionBorder">#d9d6ce</code></span></div></div></div>`;
}

export function renderSettingsPage(): string {
  const body = `<section class="page-heading"><div><h1>Settings</h1></div></section>
  <section class="panel settings-page">
    <div class="settings-group"><h2>Accent color</h2><div class="theme-options">${themeOption("accent", "forest", "Forest", "#315c52")}${themeOption("accent", "blue", "Blue", "#3d5a80")}${themeOption("accent", "terracotta", "Terracotta", "#9a4e36")}${themeOption("accent", "plum", "Plum", "#6b4c73")}${themeOption("accent", "slate", "Slate", "#58606a")}${customThemeOption("accent", "#315c52")}</div></div>
    <div class="settings-group"><h2>Background color</h2><div class="theme-options">${themeOption("background", "paper", "Paper", "#f7f6f2")}${themeOption("background", "white", "White", "#ffffff")}${themeOption("background", "light-gray", "Light gray", "#eeeeec")}${themeOption("background", "warm", "Warm", "#f3efe8")}${themeOption("background", "mint", "Mint", "#e5f1ea")}${customThemeOption("background", "#f7f6f2")}</div>${derivedColorPreview()}</div>
    <div class="settings-group"><h2>Content width</h2><p class="muted">Choose the width of the central content area on larger screens.</p><div class="width-options">${widthOption("50")}${widthOption("60")}${widthOption("70")}${widthOption("80")}${widthOption("90")}${widthOption("100")}</div></div>
    <div class="settings-group"><h2>Entries per page</h2><p class="muted">Choose how many papers appear on each library page.</p><div class="width-options">${pageSizeOption("10")}${pageSizeOption("25")}${pageSizeOption("50")}${pageSizeOption("100")}</div></div>
    <div class="settings-group"><h2>AI providers</h2><p class="muted">Choose the provider used for on-demand paper summaries and questions.</p><form data-ai-settings><section class="settings-subsection active-provider-settings"><h3>Active provider</h3><label>Provider<select name="provider"><option value="openai">OpenAI</option><option value="ollama">Ollama</option></select></label></section><div class="ai-provider-columns"><section class="settings-subsection"><h3>OpenAI</h3><label>Model<select name="openaiModel"><option>gpt-5-nano</option><option>gpt-5.4-nano</option><option>gpt-5.4-mini</option><option>gpt-5.4</option><option>gpt-5.5</option><option>gpt-4.1-mini</option><option>gpt-4.1</option><option>gpt-4.1-nano</option><option>gpt-4o-mini</option><option>gpt-4o</option></select></label><label>API key<input name="openaiApiKey" type="password" autocomplete="new-password" placeholder="Enter a replacement key"><span class="muted" data-openai-key-status>Checking key status…</span></label></section><section class="settings-subsection"><h3>Ollama</h3><label>Base URL<input name="ollamaBaseUrl" type="url" placeholder="http://localhost:11434"></label><label>Model<div class="field-with-action ollama-model-picker"><select name="ollamaModel" aria-label="Ollama model"><option value="">Choose an available model…</option></select><button class="icon-button" type="button" data-load-ollama-models aria-label="Refresh Ollama models" title="Refresh Ollama models">${refreshIcon()}</button></div><span class="muted" data-ollama-model-status>Select an Ollama URL to load available models.</span></label></section></div><div class="ai-key-actions"><button class="button button-secondary" type="submit">Save AI settings</button><button class="button button-secondary" type="button" data-clear-openai-key>Clear OpenAI key</button></div><p class="form-status" data-ai-settings-status role="status"></p></form></div>
    <div class="settings-group"><h2>Backup and restore</h2><p class="muted">Download your metadata and PDFs as one backup file, or restore a backup into this library. Existing papers are preserved.</p><div class="backup-actions"><a class="button button-secondary" href="/api/export/backup">Download backup</a><form data-restore-backup><label class="backup-file">Choose backup<input name="backup" type="file" accept="application/json,.json" required></label><button class="button button-secondary" type="submit">Restore backup</button><p class="form-status" role="status"></p></form></div></div>
  </section>`;
  return layout("Settings", body);
}
