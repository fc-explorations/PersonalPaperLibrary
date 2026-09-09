import type { PaperRecord, PaperMetadata, SortOrder } from "./types.js";
import type { TagFilterMode } from "./repositories/papers.js";
import type { SummaryRecord, StoredQuestion } from "./repositories/analysis.js";
import { NO_PDF_TAG } from "./services/system-tags.js";
import { parseBibtex } from "./services/bibtex.js";
import { compactQuickSummary } from "./services/quick-summary.js";
import { APP_VERSION_LABEL } from "./version.js";

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
  <link rel="stylesheet" href="/styles.css?v=57">
  <script>window.MathJax = { tex: { inlineMath: [["$", "$"], ["\\\\(", "\\\\)"]], displayMath: [["$$", "$$"], ["\\\\[", "\\\\]"]], macros: { textit: ["{\\\\mathit{#1}}", 1], emph: ["{\\\\mathit{#1}}", 1], textbf: ["{\\\\mathbf{#1}}", 1], texttt: ["{\\\\mathtt{#1}}", 1], url: ["{\\\\mathtt{#1}}", 1] } }, startup: { typeset: false }, options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre", "code"] } };</script>
  <script defer src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</head>
<body>
  <div class="render-root">
    ${showHeader ? `<header class="site-header"><div class="shell"><div class="brand-lockup"><a class="brand" href="/" aria-label="PersonalPaperLibrary">${wordmark()}</a>${brandVersion()}</div><div class="header-actions">${settingsLink()}</div></div></header>` : ""}
    <main class="shell">${body}</main>
  </div>
    <script src="/app.js?v=44" defer></script>
</body>
</html>`;
}

function wordmark(): string {
  return `<span class="wordmark"><span>Personal</span><span class="wordmark-paper">Paper</span><span>Library</span></span>`;
}

function brandVersion(): string {
  return `<span class="brand-version" aria-label="Version ${escapeHtml(APP_VERSION_LABEL)}">${escapeHtml(APP_VERSION_LABEL)}</span>`;
}

function addAction(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">add</span><span>Add</span>`;
}

function addIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">add</span>`;
}

function settingsIcon(): string {
  return `<svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.02-.66-.07-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.6-.22l-2.49 1a7.7 7.7 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.5.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.04.32-.08.65-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .6.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .5-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1a.5.5 0 0 0 .6-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>`;
}

function settingsLink(): string {
  return `<a class="settings-link" href="/settings" aria-label="Settings" title="Settings">${settingsIcon()}</a>`;
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

function paperIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">description</span>`;
}

function goIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span>`;
}

function downloadIcon(): string {
  return `<span class="material-symbols-outlined" aria-hidden="true">download</span>`;
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

export function summarySectionIcon(): string {
  return `<svg class="section-heading-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="5" y="3.5" width="14" height="17" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
}

export function questionsSectionIcon(): string {
  return `<svg class="section-heading-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6.5 4.5h11A2.5 2.5 0 0 1 20 7v6.5a2.5 2.5 0 0 1-2.5 2.5H11l-3.5 3v-3H6.5A2.5 2.5 0 0 1 4 13.5V7a2.5 2.5 0 0 1 2.5-2.5Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9.5 9.25a2.5 2.5 0 1 1 4.2 1.82c-.92.84-1.7 1.14-1.7 2.43M12 16.5v.01" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
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
    paper.acceptedVenue ? ["booktitle", paper.acceptedVenue] : null,
    paper.doi ? ["doi", paper.doi] : null,
    paper.isbn ? ["isbn", paper.isbn] : null,
    paper.arxivId ? ["eprint", paper.arxivId] : null,
    paper.arxivId ? ["archivePrefix", "arXiv"] : null,
    paper.sourceUrl || paper.arxivUrl ? ["url", paper.sourceUrl || paper.arxivUrl || ""] : null,
  ].filter((field): field is [string, string] => Boolean(field));
  const type = paper.acceptedVenue ? "inproceedings" : paper.journalRef ? "article" : "misc";
  return [`@${type}{${bibtexKey(paper)},`, ...fields.map(([name, value], index) => `  ${name} = {${bibtexEscape(value)}}${index === fields.length - 1 ? "" : ","}`), "}"].join("\n");
}

function storedBibtex(paper: PaperRecord): string | undefined {
  const source = typeof paper.bibtex === "string" ? paper.bibtex.trim() : "";
  if (!source) return undefined;
  parseBibtex(source);
  return source;
}

/** Render one exportable BibTeX entry, rejecting records without the required title. */
export function renderBibtexEntry(paper: PaperRecord): string {
  if (!paper || typeof paper.title !== "string" || !paper.title.trim()) throw new Error("BIBTEX_TITLE_MISSING");
  try {
    return storedBibtex(paper) || bibtexEntry(paper);
  } catch {
    return bibtexEntry(paper);
  }
}

/** Render all valid entries while isolating malformed records from the rest of an export. */
export function renderBibtexExport(papers: PaperRecord[]): string {
  const entries: string[] = [];
  for (const paper of papers) {
    try {
      const entry = storedBibtex(paper) || renderBibtexEntry(paper);
      if (entry.trim()) entries.push(entry);
    } catch {
      // A single malformed record should not prevent the remaining papers from exporting.
    }
  }
  return entries.length ? `${entries.join("\n\n")}\n` : "";
}

function citationAuthorParts(author: string): { family: string; given: string } {
  const parts = author.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) return { family: parts[0], given: parts.slice(1).join(" ") };
  const words = author.trim().split(/\s+/).filter(Boolean);
  return { family: words.pop() || "Unknown", given: words.join(" ") };
}

function citationInitials(given: string): string {
  return given.split(/[\s-]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}.`).join(" ");
}

function joinCitationAuthors(names: string[], conjunction: string): string {
  if (!names.length) return "Unknown author";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} ${conjunction} ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, ${conjunction} ${names.at(-1)}`;
}

function citationYear(paper: PaperRecord): string {
  return String(paper.year || paper.publishedDate?.slice(0, 4) || "");
}

function citationWithVenue(text: string, venue: string): { text: string; html: string } {
  const marker = "%%VENUE%%";
  return { text: text.replace(marker, venue), html: escapeHtml(text).replace(marker, `<em>${escapeHtml(venue)}</em>`) };
}

function citationStyles(paper: PaperRecord): Array<{ label: string; text: string; html: string }> {
  const parts = paper.authors.map(citationAuthorParts);
  const mlaAuthors = joinCitationAuthors(parts.map((part, index) => index === 0 ? `${part.family}, ${part.given}`.trim() : `${part.given} ${part.family}`.trim()), "and");
  const apaAuthors = joinCitationAuthors(parts.map((part) => `${part.family}, ${citationInitials(part.given)}`.trim()), "&");
  const chicagoAuthors = mlaAuthors;
  const harvardAuthors = joinCitationAuthors(parts.map((part) => `${part.family}, ${citationInitials(part.given)}`.trim()), "and");
  const vancouverAuthors = parts.map((part) => `${part.family} ${citationInitials(part.given)}`.trim()).join(", ") || "Unknown author";
  const title = paper.title.trim();
  const venue = paper.acceptedVenue?.trim() || paper.journalRef?.trim() || "";
  const year = citationYear(paper);
  const yearOrNd = year || "n.d.";
  const entries = [
    ["MLA", `${mlaAuthors}. "${title}."${venue ? ` %%VENUE%%.` : ""}${year ? ` ${year}.` : ""}`],
    ["APA", `${apaAuthors} (${yearOrNd}). ${title}.${venue ? " %%VENUE%%." : ""}`],
    ["Chicago", `${chicagoAuthors}. "${title}."${venue ? " In %%VENUE%%," : ""}${year ? ` ${year}.` : ""}`],
    ["Harvard", `${harvardAuthors} (${yearOrNd}). ${title}.${venue ? " %%VENUE%%." : ""}`],
    ["Vancouver", `${vancouverAuthors}. ${title}.${venue ? " %%VENUE%%." : ""}${year ? ` ${year}.` : ""}`],
  ] as const;
  return entries.map(([label, value]) => {
    const citation = citationWithVenue(value, venue);
    return { label, text: citation.text, html: citation.html };
  });
}

export function renderCitationSection(paper: PaperRecord): string {
  const bibtex = renderBibtexEntry(paper);
  const bibtexRows = Math.max(3, bibtex.split(/\r?\n/).length);
  const compactCitations = citationStyles(paper).map(({ label, text, html }) => `<article class="citation-style"><div class="citation-style-heading"><strong>${escapeHtml(label)}</strong><button class="button button-secondary button-small" type="button" data-copy-citation="${escapeHtml(text)}"><span class="material-symbols-outlined" aria-hidden="true">content_copy</span><span>Copy</span></button></div><p class="citation-text">${html}</p></article>`).join("");
  return `<details class="detail-section bibtex-section"><summary>Cite</summary><div class="bibtex-body"><div class="bibtex-heading"><p class="eyebrow">BibTeX</p><button class="button button-secondary" type="button" data-copy-bibtex><span class="material-symbols-outlined" aria-hidden="true">content_copy</span><span>Copy</span></button></div><textarea class="bibtex-text" data-bibtex readonly rows="${bibtexRows}" aria-label="BibTeX entry">${escapeHtml(bibtex)}</textarea><div class="citation-styles"><p class="eyebrow">Compact styles</p>${compactCitations}</div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse Cite" title="Collapse Cite"><span class="material-symbols-outlined" aria-hidden="true">keyboard_arrow_up</span></button></div></div></details>`;
}

function tagLinks(tags: string[], selected?: string): string {
  return tags.map((tag) => `<a class="tag ${selected?.toLowerCase() === tag.toLowerCase() ? "tag-selected" : ""}" href="/?tag=${encodeURIComponent(tag)}">${escapeHtml(displayTagName(tag))}</a>`).join(" ");
}

function displayTagName(tag: string): string {
  return tag.toLowerCase() === NO_PDF_TAG ? "NO PDF" : tag;
}

function libraryQuery(q: string | undefined, tags: string[], sort: SortOrder, all: boolean | "none" = false, untagged = false, page = 1, pageSize = 50, tagMode: TagFilterMode = "or", noTags = false): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  tags.forEach((tag) => params.append("tag", tag));
  params.set("sort", sort);
  if (all === true) params.set("all", "1");
  else if (all === "none" || noTags) params.set("all", "0");
  if (untagged) params.set("untagged", "1");
  params.set("tagMode", tagMode);
  if (pageSize !== 50) params.set("pageSize", String(pageSize));
  if (page > 1) params.set("page", String(page));
  return params.toString();
}

function librarySelectionQuery(ids: string[]): string {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append("selected", id));
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

function groupTagLinks(tags: string[], selected: string[], q: string | undefined, sort: SortOrder, tagMode: TagFilterMode, pageSize = 50): string {
  return tags.map((tag) => {
    const isSelected = selected.some((value) => value.toLowerCase() === tag.toLowerCase());
    const next = isSelected ? selected.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...selected, tag];
    return `<a class="tag ${isSelected ? "tag-selected" : ""}" href="/?${libraryQuery(q, next, sort, false, false, 1, pageSize, tagMode)}" aria-pressed="${isSelected}">${escapeHtml(displayTagName(tag))}</a>`;
  }).join(" ");
}

function authorLine(authors: string[]): string {
  if (authors.length <= 3) return authors.join(", ");
  return `${authors.slice(0, 3).join(", ")} et al.`;
}

function paperYear(paper: PaperRecord): string | undefined {
  return paper.year ? String(paper.year) : paper.publishedDate?.slice(0, 4) || undefined;
}

function paperHeaderSummary(paper: PaperRecord): string {
  const arxiv = paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">arXiv:${escapeHtml(paper.arxivId)}</a>` : undefined;
  const authors = paper.authors.length ? `<span class="paper-authors">${escapeHtml(authorLine(paper.authors))}</span>` : undefined;
  return [authors, paper.acceptedVenue || paper.journalRef ? escapeHtml(paper.acceptedVenue || paper.journalRef || "") : undefined, paperYear(paper) ? escapeHtml(paperYear(paper) || "") : undefined, arxiv].filter(Boolean).join(" · ");
}

function metadataRow(label: string, value: unknown, content = renderText(value)): string {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return "";
  return `<dt>${escapeHtml(label)}</dt><dd>${content}</dd>`;
}

function paperCard(paper: PaperRecord, selectedIds: string[] = []): string {
  const summary = paperHeaderSummary(paper);
  const selected = selectedIds.includes(paper.id);
  return `<article class="paper-card">
    <label class="paper-select"><input type="checkbox" data-select-paper="${escapeHtml(paper.id)}" aria-label="Select ${escapeHtml(paper.title)}"${selected ? " checked" : ""}></label>
    <div class="paper-card-main"><h2><a href="/papers/${encodeURIComponent(paper.id)}">${renderText(paper.title, false)}</a></h2>
    ${summary ? `<p class="muted">${summary}</p>` : ""}</div>
    ${paper.tags.length ? `<div class="paper-tags">${tagLinks(paper.tags)}</div>` : ""}
  </article>`;
}

export function renderAskLibraryPage(tags: string[]): string {
  const tagOptions = tags.map((tag) => `<button class="tag ask-tag-button" type="button" data-library-tag="${escapeHtml(tag)}" aria-pressed="false">${escapeHtml(displayTagName(tag))}</button>`).join("");
  const body = `<section class="page-heading ask-heading"><h1>Ask the library</h1></section>
  <section class="panel ask-library-page" data-library-ask>
    <form id="library-query-form" data-library-query class="ask-query-form"><div class="ask-query-input-row"><textarea id="library-query-input" name="query" rows="3" maxlength="1000" required placeholder="Which papers study uncertainty calibration without using ensembles?"></textarea></div><div class="ask-query-controls-row"><div class="ask-query-toolbar"><div class="ask-tag-filter"><span class="ask-control-label">Search within</span><div class="ask-tag-selection"><div class="tag-mode-switch" role="group" aria-label="Tag matching mode"><span class="tag-mode-label">Match:</span><button class="tag tag-mode-button" type="button" data-library-tag-mode="and" aria-pressed="false">AND</button><button class="tag tag-mode-button tag-selected" type="button" data-library-tag-mode="or" aria-pressed="true">OR</button></div><div class="ask-tag-row"><span class="tag-mode-label">Tags:</span><div class="ask-tag-options"><button class="tag tag-selected ask-tag-button" type="button" data-library-tag-all aria-pressed="true">ALL</button>${tagOptions || `<span class="muted">No tags yet</span>`}</div></div></div></div></div><div class="ask-submit-row"><button class="button button-secondary button-small ask-rephrase" type="button" data-library-query-rephrase>${analysisIcon()}<span>Rephrase</span></button><button class="button button-secondary button-small ask-submit" type="submit" form="library-query-form" data-library-query-submit>${analysisIcon()}<span>Ask</span></button></div></div><p class="form-status" data-library-query-status role="status"></p></form>
    <section class="ask-results" data-library-query-results hidden aria-live="polite"></section>
  </section>
  <section class="page-heading indexing-heading"><h1>Indexing</h1></section>
  <div class="panel ask-indexing-panel" data-library-indexing><div class="ask-indexing-row"><span class="muted ask-indexing-status" data-library-index-status>Checking index coverage…</span><div class="ask-indexing-actions"><button class="button button-secondary button-small ask-index-button" type="button" data-library-index-continue data-index-limit="20">${refreshIcon()}<span data-library-index-label>Index papers</span></button><button class="button button-secondary button-small ask-index-button" type="button" data-library-index-continue data-index-limit="80">${refreshIcon()}<span data-library-index-label>Index more</span></button><button class="button button-secondary button-small ask-index-button" type="button" data-library-index-continue data-index-limit="150">${refreshIcon()}<span data-library-index-label>Index many</span></button></div></div><p class="form-status ask-indexing-message" data-library-index-status-message role="status"></p><section class="ask-indexing-failures" data-library-abstract-failures hidden><h2>Abstracts needing attention</h2><ul class="ask-abstract-failure-list" data-library-abstract-failure-list></ul></section></div>`;
  return layout("Ask the library", body);
}

export function renderLibrary(papers: PaperRecord[], tags: string[], query: { q?: string; tag?: string[]; tagMode?: TagFilterMode; selected?: string[]; sort?: SortOrder; all?: boolean; noTags?: boolean; untagged?: boolean; page?: number; pageSize?: number; total?: number; storedPdfCount?: number }): string {
  const sort = query.sort || "newest";
  const page = query.page || 1;
  const pageSize = query.pageSize || 50;
  const total = query.total ?? papers.length;
  const selectedFilters = query.tag || [];
  const tagMode = query.tagMode || "or";
  const selectedIds = query.selected || [];
  const allSelected = Boolean(query.all);
  const untaggedSelected = Boolean(query.untagged);
  const allTagsSelected = allSelected;
  const noPdfSelected = selectedFilters.some((tag) => tag.toLowerCase() === NO_PDF_TAG);
  const customTags = tags.filter((tag) => tag.toLowerCase() !== NO_PDF_TAG);
  const noPdfFilters = noPdfSelected ? selectedFilters.filter((tag) => tag.toLowerCase() !== NO_PDF_TAG) : [...selectedFilters, NO_PDF_TAG];
  const noPdfLink = `<a class="tag ${noPdfSelected ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, noPdfFilters, sort, false, false, 1, pageSize, tagMode)}" aria-pressed="${noPdfSelected}">NO PDF</a>`;
  const downloadQuery = selectedIds.length ? librarySelectionQuery(selectedIds) : libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize, tagMode, query.noTags);
  const storedPdfCount = query.storedPdfCount ?? papers.filter((paper) => paper.r2Key).length;
  const selectionCount = selectedIds.length || total;
  const hasSelection = Boolean(total && (selectedIds.length || query.q?.trim() || selectedFilters.length || allSelected || untaggedSelected));
  const selectedTags = [...new Set(papers.flatMap((paper) => paper.tags).map((tag) => tag.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const selectedTagOptions = selectedTags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(displayTagName(tag))}</option>`).join("");
  const selectionLabel = selectedIds.length ? "Delete selected" : allSelected ? "Delete all" : untaggedSelected ? "Delete untagged" : query.q?.trim() || selectedFilters.length > 1 ? "Delete selected" : "Delete group";
  const selectionTags = escapeHtml(JSON.stringify(selectedFilters));
  const selectionIds = escapeHtml(JSON.stringify(selectedIds));
  const bulkButtons = hasSelection ? `<div class="bulk-actions" data-bulk-actions>${selectedIds.length ? `<button class="button button-secondary" type="button" data-batch-metadata data-batch-metadata-ids="${selectionIds}">${searchIcon()}<span>Find metadata</span></button>` : ""}<button class="button button-secondary" type="button" data-toggle-bulk-tags aria-expanded="false">${editIcon()}<span>Edit tags</span></button><a class="button button-secondary" href="/api/export/bibtex?${downloadQuery}">${downloadIcon()}<span>Export BibTeX</span></a>${storedPdfCount ? `<a class="button button-secondary" href="/api/export/pdfs?${downloadQuery}">${downloadIcon()}<span>Download ${storedPdfCount} PDF${storedPdfCount === 1 ? "" : "s"}</span></a>` : ""}<button class="button button-danger" type="button" data-delete-group data-delete-all="${allSelected}" data-delete-untagged="${untaggedSelected}" data-delete-query="${escapeHtml(query.q || "")}" data-delete-tags="${selectionTags}" data-delete-tag-mode="${tagMode}" data-delete-selected-ids="${selectionIds}" data-delete-count="${selectionCount}">${deleteIcon()}<span>${selectionLabel}</span></button></div>` : "";
  const bulkTagEditor = hasSelection ? `<div class="bulk-tag-editor" data-bulk-tag-editor hidden><form data-bulk-tag-form data-selection-all="${allSelected}" data-selection-untagged="${untaggedSelected}" data-selection-query="${escapeHtml(query.q || "")}" data-selection-tags="${selectionTags}" data-selection-tag-mode="${tagMode}" data-selection-ids="${selectionIds}"><label>Tag to apply<div class="bulk-tag-fields"><select name="tag" data-bulk-tag-select required><option value="">Choose a tag…</option>${selectedTagOptions}<option value="__new__">New tag…</option></select><input name="newTag" data-new-tag placeholder="New tag name" hidden></div></label><div class="bulk-tag-actions"><button class="button button-secondary" type="submit" data-bulk-tag-action="add">${addIcon()}<span>Add tag</span></button><button class="button button-danger" type="submit" data-bulk-tag-action="remove">${deleteIcon()}<span>Remove tag</span></button><button class="button button-secondary" type="button" data-cancel-bulk-tags>${closeIcon()}<span>Cancel</span></button></div><p class="form-status" role="status"></p></form></div>` : "";
  const pageCount = Math.ceil(total / pageSize);
  const pageLinks = paginationPages(page, pageCount).map((pageNumber) => pageNumber === "ellipsis"
    ? `<span class="pagination-ellipsis" aria-hidden="true">…</span>`
    : pageNumber === page
      ? `<span class="button button-secondary button-small page-number" aria-current="page">${pageNumber}</span>`
      : `<a class="button button-secondary button-small page-number" href="/?${libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, pageNumber, pageSize, tagMode, query.noTags)}">${pageNumber}</a>`).join("");
  const firstPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize, tagMode, query.noTags);
  const previousPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, page - 1, pageSize, tagMode, query.noTags);
  const nextPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, page + 1, pageSize, tagMode, query.noTags);
  const lastPage = libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, pageCount, pageSize, tagMode, query.noTags);
  const pagination = pageCount > 1 ? `<div class="pagination-footer"><span class="muted pagination-summary">Page ${page} of ${pageCount}</span><nav class="pagination" aria-label="Paper pages">${page > 1 ? `<a class="button button-secondary button-small" href="/?${firstPage}">First</a><a class="button button-secondary button-small" href="/?${previousPage}">Previous</a>` : `<span class="button button-secondary button-small pagination-disabled" aria-disabled="true">First</span><span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Previous</span>`}<span class="pagination-pages">${pageLinks}</span>${page < pageCount ? `<a class="button button-secondary button-small" href="/?${nextPage}">Next</a><a class="button button-secondary button-small" href="/?${lastPage}">Last</a>` : `<span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Next</span><span class="button button-secondary button-small pagination-disabled" aria-disabled="true">Last</span>`}</nav></div>` : "";
  const body = `<div class="library-controls"><div class="library-primary-actions"><a class="button add-paper-button add-paper-square" href="/add" aria-label="Add paper" title="Add paper">${addIcon()}</a><a class="button button-secondary ask-library-button" href="/ask">${analysisIcon()}<span>Ask the library</span></a></div><form class="toolbar" method="get" action="/">
    <label class="search-label"><span class="sr-only">Search papers</span><span class="search-input-wrap"><input name="q" value="${escapeHtml(query.q)}" placeholder="Search titles, authors, abstracts, tags…"><button class="clear-input" type="button" data-clear-search aria-label="Clear search" title="Clear search" hidden><span class="material-symbols-outlined" aria-hidden="true">close</span></button></span></label>
    ${allSelected ? `<input type="hidden" name="all" value="1">` : query.noTags ? `<input type="hidden" name="all" value="0">` : ""}${untaggedSelected ? `<input type="hidden" name="untagged" value="1">` : ""}${selectedFilters.map((tag) => `<input type="hidden" name="tag" value="${escapeHtml(tag)}">`).join("")}<input type="hidden" name="tagMode" value="${tagMode}"><input type="hidden" name="pageSize" value="${pageSize}">
    <select name="sort" aria-label="Sort papers"><option value="newest" ${sort === "newest" ? "selected" : ""}>Newest added</option><option value="oldest" ${sort === "oldest" ? "selected" : ""}>Oldest added</option><option value="year-desc" ${sort === "year-desc" ? "selected" : ""}>Publication year ↓</option><option value="year-asc" ${sort === "year-asc" ? "selected" : ""}>Publication year ↑</option><option value="title" ${sort === "title" ? "selected" : ""}>Title A–Z</option></select>
    <button class="button button-secondary" type="submit">${searchIcon()}<span>Search</span></button>
  </form></div>
  <section class="tag-bar" data-library-page-size="${pageSize}"><span class="tag-mode-label">Match:</span> <a class="tag tag-mode-button ${tagMode === "and" ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize, "and", query.noTags)}" aria-pressed="${tagMode === "and"}">AND</a> <a class="tag tag-mode-button ${tagMode === "or" ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, selectedFilters, sort, allSelected, untaggedSelected, 1, pageSize, "or", query.noTags)}" aria-pressed="${tagMode === "or"}">OR</a> <span class="tag-mode-label">Tags:</span> <a class="tag ${allTagsSelected ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, [], sort, allSelected ? "none" : true, false, 1, pageSize, tagMode)}" aria-pressed="${allTagsSelected}">ALL</a> <a class="tag ${untaggedSelected ? "tag-selected" : ""}" href="/?${libraryQuery(query.q, [], sort, false, !untaggedSelected, 1, pageSize, tagMode)}" aria-pressed="${untaggedSelected}">NONE</a> ${noPdfLink} ${groupTagLinks(customTags, allTagsSelected || untaggedSelected ? [] : selectedFilters, query.q, sort, tagMode, pageSize)}</section>
  <div class="results-heading"><span class="muted">${total} paper${total === 1 ? "" : "s"}</span><div class="results-actions" data-local-bulk-actions>${bulkButtons}${bulkTagEditor}</div></div>
  <section class="paper-list${bulkButtons ? " has-bulk-actions" : ""}${papers.length ? "" : " empty-paper-list"}">${papers.length ? papers.map((paper) => paperCard(paper, selectedIds)).join("\n") : `<div class="empty-state"><h2>No papers found</h2><p class="muted">Add a paper or upload a PDF to start your collection.</p><a class="button" href="/add">Add your first paper</a></div>`}</section>${pagination}`;
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
  return `<label>Source URL<div class="field-with-action"><input name="sourceUrl" type="text" value="${escapeHtml(value)}"><a class="button button-secondary button-small form-utility-button edit-action-button" data-source-url-go href="${validUrl ? escapeHtml(url) : "#"}" target="_blank" rel="noreferrer"${validUrl ? "" : " hidden"}>${goIcon()}<span>Go</span></a></div></label>`;
}

function abstractField(value: unknown): string {
  return `<label>Abstract<div class="field-with-action abstract-field"><textarea name="abstract" rows="6">${escapeHtml(value)}</textarea><button class="button button-secondary button-small form-utility-button edit-action-button" type="button" data-extract-abstract>${analysisIcon()}<span>From PDF</span></button></div></label>`;
}

export function bibtexImportField(formId: string, value = ""): string {
  return `<div class="bibtex-import"><label>BibTeX<div class="field-with-action bibtex-import-field"><textarea name="bibtex" data-bibtex-import form="${escapeHtml(formId)}" rows="7" placeholder="Paste one BibTeX entry here">${escapeHtml(value)}</textarea><button class="button button-secondary form-utility-button edit-action-button" type="button" form="${escapeHtml(formId)}" data-import-bibtex>${searchIcon()}<span>From TeX</span></button></div></label><span class="form-status" data-bibtex-status role="status"></span></div>`;
}

function formActions(formId: string): string {
  return `<div class="form-actions"><div class="form-actions-row"><div class="form-actions-right"><button class="button button-secondary edit-action-button" type="button" form="${escapeHtml(formId)}" data-lookup-metadata>${searchIcon()}<span>Find</span></button></div></div><span class="form-status" data-form-status-for="${escapeHtml(formId)}" role="status"></span></div>`;
}

export function renderPaperForm(paper?: Partial<PaperRecord & PaperMetadata>, mode: "add" | "edit" = "add", actionsOutside = false): string {
  const isEdit = mode === "edit";
  const data = paper || { title: "", authors: [], categories: [], tags: [] };
  const formId = isEdit ? `paper-form-${data.id}` : "paper-form-new";
  const authorCount = (data.authors || []).length;
  const authorRows = Math.max(3, Math.min(authorCount || 3, 10));
  const openPdfUrl = isEdit && data.r2Key ? `/api/papers/${escapeHtml(data.id)}/pdf` : "";
  const openPdfButton = `<a class="button button-secondary button-small form-utility-button edit-action-button" data-paper-pdf-link${openPdfUrl ? ` href="${openPdfUrl}"` : ""} target="_blank" rel="noopener noreferrer" aria-label="Open PDF" title="Open PDF"${openPdfUrl ? "" : " hidden"}>${openIcon()}<span>Open</span></a>`;
  const titleField = `<label>Title<div class="field-with-action title-field"><input name="title" type="text" value="${escapeHtml(data.title)}" placeholder="Paper title">${openPdfButton}</div></label>`;
  const tagsField = `<div class="tag-field"><label>Tags<input name="tags" type="text" value="${escapeHtml((data.tags || []).map(displayTagName).join(", "))}" placeholder="topic, project, method"></label><button class="button button-secondary button-small form-utility-button edit-action-button" type="button" data-suggest-tags>${analysisIcon()}<span>Suggest</span></button><div class="tag-suggestions" data-tag-suggestions hidden><div class="tag-suggestions-heading"><strong>Suggested tags</strong><span class="muted" data-tag-suggestions-status></span></div><div class="tag-suggestion-list" data-tag-suggestion-list></div><button class="button button-secondary button-small" type="button" data-apply-tag-suggestions>Add selected tags</button></div></div>`;
  const fields = `${titleField}
    ${field("Authors", "authors", (data.authors || []).join("\n"), { rows: authorRows, placeholder: "One author per line" })}
    <div class="form-row">${field("Year", "year", data.year, { type: "number", placeholder: "2025" })}${field("Published date", "publishedDate", data.publishedDate, { placeholder: "2025-01-01" })}</div>
    ${abstractField(data.abstract)}
    <div class="form-row">${field("Primary category", "primaryCategory", data.primaryCategory, { placeholder: "cs.AI" })}${field("Categories", "categories", (data.categories || []).join(", "), { placeholder: "cs.AI, cs.LG" })}</div>
    <div class="form-row">${field("Journal reference", "journalRef", data.journalRef)}${field("Accepted venue", "acceptedVenue", data.acceptedVenue)}</div>
    <div class="form-row">${field("DOI", "doi", data.doi)}${field("ISBN", "isbn", data.isbn, { placeholder: "9780262381369" })}</div>
    <div class="form-row">${field("arXiv ID", "arxivId", data.arxivId, { placeholder: "2401.12345" })}${sourceUrlField(data.sourceUrl)}</div>
    ${tagsField}`;
  const actions = formActions(formId);
  return `<form id="${escapeHtml(formId)}" class="paper-form" data-paper-form data-mode="${mode}" ${isEdit ? `data-paper-id="${escapeHtml(data.id)}"` : ""}>
    <input type="hidden" name="stagingToken" value="">
    ${actionsOutside ? "" : actions}
    <div class="form-grid">${fields}</div>
  </form>`;
}

export function renderAddPage(): string {
  const body = `<section class="add-grid add-options">
    <div class="panel"><h2>Find a paper</h2><p class="muted">Accepted inputs include a paper title or pasted citation, a DOI (for example, 10.1234/abc or a doi.org link), ISBN-10 or ISBN-13, an arXiv ID or link (for example, 2401.12345), or a URL to the paper.</p><form data-import-form><div class="inline-form"><input name="input" required placeholder="Title, citation, DOI, ISBN, arXiv ID, or URL"><button class="button" type="submit">${searchIcon()}<span>Find</span></button></div><p class="form-status" role="status"></p></form><form class="find-pdf-upload" data-upload-form><p class="muted upload-help">Already have the file? Upload one PDF directly to create an editable paper record.</p><div class="inline-form"><input id="single-pdf-input" name="file" type="file" accept="application/pdf,.pdf" required data-single-pdf-input><button class="button button-secondary" type="submit">${uploadIcon()}<span>Upload PDF</span></button></div><p class="form-status" role="status"></p></form></div>
    <div class="add-file-options"><div class="panel"><h2>Import</h2><p class="muted">Import PDFs in bulk from a folder or ZIP archive. Each PDF becomes an editable paper record with its filename as the initial title; metadata is enriched when possible. ZIPs may include subfolders, and only PDF files are imported. You can optionally add the containing folder name as a tag, with up to 200 PDFs per batch.</p><form data-bulk-upload-form><div class="inline-form folder-import-controls"><div class="folder-import-pickers"><div class="file-picker"><label class="button button-secondary" for="folder-pdf-input">${folderIcon()}<span>From Folder</span></label><input id="folder-pdf-input" name="files" type="file" accept="application/pdf,.pdf" webkitdirectory multiple class="sr-only" data-folder-pdf-input></div><div class="file-picker"><label class="button button-secondary" for="folder-zip-input"><span class="material-symbols-outlined" aria-hidden="true">folder_zip</span><span>From ZIP</span></label><input id="folder-zip-input" name="files" type="file" accept="application/zip,.zip" class="sr-only" data-folder-zip-input></div></div><label class="folder-tag-toggle"><span>Use folder as tag</span><input type="checkbox" data-folder-tag-toggle checked><span class="toggle-track" aria-hidden="true"><span class="toggle-thumb"></span></span><span class="folder-tag-value" data-folder-tag-value>True</span></label></div><p class="form-status" role="status"></p><div class="bulk-progress" data-bulk-progress hidden role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span data-bulk-progress-fill></span></div><div class="bulk-results" data-bulk-results></div></form></div></div>
  </section>
  <section class="panel preview-panel" data-preview hidden><div class="preview-header"><div><p class="eyebrow">Paper details</p><h2>Paper details</h2></div><div class="preview-actions"><span class="pdf-status" data-pdf-status></span>${formActions("paper-form-new")}</div></div><div data-preview-form>${renderPaperForm(undefined, "add", true)}${bibtexImportField("paper-form-new")}</div><div class="warnings" data-warnings></div></section>`;
  return layout("Add paper", body);
}

export function analysisMeta(provider: string, model: string, generatedAt: string, durationMs?: number, className = "analysis-meta"): string {
  const duration = durationMs === undefined ? "" : ` · ${Math.floor(durationMs / 60000)}:${String(Math.floor(durationMs / 1000) % 60).padStart(2, "0")}`;
  return `<p class="${className} muted">${escapeHtml(provider)} · ${escapeHtml(model)} · ${escapeHtml(new Date(generatedAt).toLocaleString("en-GB"))}${duration}</p>`;
}

function renderSummarySection(summary?: SummaryRecord | null): string {
  const state = summary?.status === "stale" ? `<p class="status-warning">The stored summary is stale because the PDF changed. Regenerate it.</p>` : summary?.status === "error" ? `<p class="status-error">Summary generation failed: ${escapeHtml(summary.errorMessage || "Unknown error")}</p>` : "";
  const content = summary?.status === "complete" && summary.content ? `<div class="analysis-content">${renderMarkdown(summary.content.replace(/(^|\n)(\s*(?:[-*+]\s+|\d+[.)]\s+)[^\n]+(?:\n|$))+/g, (_, prefix: string, block: string) => `${prefix}${block.split(/\n/).map((line) => line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean).join(" ")}\n`))}</div>` : "";
  const buttonLabel = summary?.status === "complete" ? "Regenerate summary" : "Generate summary";
  const buttonIcon = summary?.status === "complete" ? refreshIcon() : analysisIcon();
  const button = `<button class="button button-secondary button-small" type="button" data-summary-mode="quick" data-generate-summary>${buttonIcon}<span>${buttonLabel}</span></button><button class="button button-secondary button-small" type="button" data-summary-mode="full" data-generate-summary>${analysisIcon()}<span>Full summary</span></button>`;
  const summaryComplete = summary?.status === "complete";
  const quickSummary = summaryComplete && summary?.content ? compactQuickSummary(summary.quickSummary || summary.content, 2) : "";
  const quickSummaryPanel = quickSummary ? `<aside class="analysis-quick-summary"><p class="analysis-quick-summary-label">Quick summary</p><div class="analysis-quick-summary-content">${renderMarkdown(quickSummary)}</div></aside>` : "";
  return `<details class="detail-section analysis-section" data-summary-section><summary>${summarySectionIcon()}<span>Summary</span><span class="analysis-progress-dot${summaryComplete ? " is-complete" : ""}" aria-label="${summaryComplete ? "Summary available" : "Summary not generated"}" title="${summaryComplete ? "Summary available" : "Summary not generated"}"></span></summary><div class="analysis-body summary-body"><div class="analysis-main">${state}${content}${summary ? analysisMeta(summary.provider, summary.model, summary.generatedAt, summary.durationMs) : ""}</div><div class="analysis-actions summary-actions"><div class="summary-action-buttons">${button}</div><span class="form-status" data-summary-status role="status"></span>${quickSummaryPanel}</div></div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse summary" title="Collapse summary">${collapseIcon()}</button></div></details>`;
}

export function renderQuestionsSection(questions: StoredQuestion[]): string {
  const groups = new Map<string, StoredQuestion[]>();
  questions.forEach((question) => groups.set(question.groupId, [...(groups.get(question.groupId) || []), question]));
  const groupSections = [...groups.entries()].map(([groupId, items]) => {
    const answered = items.filter((question) => question.answer?.status === "complete").length;
    const progress = items.map((question) => `<span class="question-progress-dot${question.answer?.status === "complete" ? " is-answered" : ""}" aria-hidden="true"></span>`).join("");
    return `<details class="question-group" data-question-group="${escapeHtml(groupId)}"><summary><span class="question-group-label">${escapeHtml(items[0].groupTitle)}</span><span class="question-progress" aria-label="${answered} of ${items.length} questions answered" title="${answered} of ${items.length} questions answered">${progress}</span></summary><div class="question-group-body"><p class="muted">${escapeHtml(items[0].groupDescription)}</p>${items.map((question) => { const quickSummary = question.answer?.status === "complete" ? compactQuickSummary(question.answer.quickSummary || question.answer.content, 1) : ""; const quickSummaryPanel = quickSummary ? `<aside class="analysis-quick-summary"><p class="analysis-quick-summary-label">Quick summary</p><div class="analysis-quick-summary-content">${renderMarkdown(quickSummary)}</div></aside>` : ""; return `<article class="question-item" data-question-id="${escapeHtml(question.id)}"><h3>${escapeHtml(question.label)}</h3>${question.answer?.status === "complete" ? `<div class="analysis-content question-answer">${renderMarkdown(question.answer.content)}</div>${analysisMeta(question.answer.provider, question.answer.model, question.answer.generatedAt, question.answer.durationMs, "analysis-meta question-answer-meta")}` : question.answer?.status === "error" ? `<p class="status-error">Answer generation failed: ${escapeHtml(question.answer.errorMessage || "Unknown error")}</p>` : question.answer?.status === "stale" ? `<p class="status-warning">This answer is stale because the paper or question definition changed.</p>` : `<p class="muted question-empty">Not answered yet.</p>`}<div class="question-actions"><button class="button button-secondary button-small" type="button" data-generate-question="${escapeHtml(question.id)}">${question.answer ? refreshIcon() : analysisIcon()}<span>${question.answer ? "Regenerate answer" : "Generate answer"}</span></button>${question.isCustom ? `<button class="button button-danger button-small" type="button" data-delete-question="${escapeHtml(question.id)}">${deleteIcon()}<span>Delete</span></button>` : ""}<span class="form-status" data-question-status role="status"></span>${quickSummaryPanel}</div></article>`; }).join("")}</div><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse ${escapeHtml(items[0].groupTitle)} questions" title="Collapse ${escapeHtml(items[0].groupTitle)} questions">${collapseIcon()}</button></div></details>`;
  }).join("");
  const addQuestion = `<details class="add-question-form"><summary>Add new question</summary><div class="add-question-body"><p class="muted">Ask an additional open question about this paper. It will be saved for this paper.</p><form data-add-question><label>Question<textarea name="question" required maxlength="5000" rows="3" placeholder="What else would you like to know?"></textarea></label><button class="button button-secondary" type="submit">${analysisIcon()}<span>Add question</span></button><p class="form-status" role="status"></p></form><div class="collapse-section-row"><button class="icon-button collapse-section-button" type="button" data-collapse-section aria-label="Collapse add new question" title="Collapse add new question">${collapseIcon()}</button></div></div></details>`;
  const overviewDots = questions.map((question) => `<span class="question-progress-dot${question.answer?.status === "complete" ? " is-answered" : ""}" data-question-overview-dot="${escapeHtml(question.id)}" aria-hidden="true"></span>`).join("");
  const answered = questions.filter((question) => question.answer?.status === "complete").length;
  const questionProgress = `<span class="question-overview-progress" aria-label="${answered} of ${questions.length} questions answered" title="${answered} of ${questions.length} questions answered">${overviewDots}</span>`;
  const questionActions = `<div class="question-section-actions"><button class="icon-button" type="button" data-toggle-questions aria-label="Expand all questions" title="Expand all questions">${expandIcon()}</button><button class="button button-secondary button-small" type="button" data-generate-all-questions>${analysisIcon()}<span>Generate all answers</span></button></div>`;
  return `<section class="detail-section analysis-questions" data-questions-section><details class="analysis-questions-disclosure"><summary>${questionsSectionIcon()}<span>Questions</span>${questionProgress}</summary>${questionActions}<p class="form-status" data-questions-status role="status"></p>${groupSections}${addQuestion}</details></section>`;
}

export function renderPaperPage(paper: PaperRecord, summary?: SummaryRecord | null, questions: StoredQuestion[] = []): string {
  const paperLine = paperHeaderSummary(paper);
  const pdfLink = paper.r2Key ? `<a class="paper-pdf-link" href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noopener noreferrer" aria-label="Open PDF" title="Open PDF">${paperIcon()}</a>` : "";
  const citeSection = renderCitationSection(paper);
  const metadata = [
    metadataRow("Authors", paper.authors.join(", ")),
    metadataRow("Year", paperYear(paper)),
    metadataRow("arXiv", paper.arxivId, paper.arxivId ? `<a href="${escapeHtml(paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`)}" target="_blank" rel="noreferrer">${escapeHtml(paper.arxivId)}</a>` : ""),
    metadataRow("Categories", paper.categories.join(", ")),
    metadataRow("Journal reference", paper.journalRef),
    metadataRow("Accepted venue", paper.acceptedVenue),
    metadataRow("DOI", paper.doi),
    metadataRow("ISBN", paper.isbn),
    metadataRow("Document", paper.r2Key ? "PDF" : "Not stored", paper.r2Key ? `<a href="/api/papers/${escapeHtml(paper.id)}/pdf" target="_blank" rel="noopener noreferrer">PDF</a>` : `<span class="muted">Not stored</span>`),
    metadataRow("Added", new Date(paper.createdAt).toLocaleString("en-GB")),
  ].join("");
  const abstractSection = paper.abstract?.trim() ? `<section class="detail-section abstract-section"><h2>Abstract</h2><p class="abstract">${renderText(paper.abstract)}</p></section>` : "";
  const tagsSection = paper.tags.length ? `<section class="detail-section detail-tags"><h2>Tags</h2><div class="paper-tags large">${tagLinks(paper.tags)}</div></section>` : "";
  const body = `<section class="page-heading paper-heading"><h1>Paper</h1><div class="page-actions"><a class="icon-button" href="/papers/${paper.id}/edit" aria-label="Edit paper" title="Edit paper">${editIcon()}<span>Edit</span></a><button class="icon-button icon-button-danger" data-delete-paper="${paper.id}" aria-label="Delete paper" title="Delete paper">${deleteIcon()}<span>Del</span></button></div></section>
  <article class="panel paper-detail" data-paper-id="${escapeHtml(paper.id)}"><div class="detail-content"><header class="paper-detail-heading"><div class="paper-title-row"><h1>${renderText(paper.title)}</h1>${pdfLink}</div>${paperLine ? `<p class="muted">${paperLine}</p>` : ""}</header>${abstractSection}${tagsSection}<details class="detail-section metadata-panel" aria-label="Paper information"><summary>Paper information</summary><dl class="metadata">${metadata}</dl></details>${citeSection}${renderSummarySection(summary)}${renderQuestionsSection(questions)}</div></article>`;
  return layout(paper.title, body);
}

export function renderEditPage(paper: PaperRecord): string {
  const formId = `paper-form-${paper.id}`;
  return layout(`Edit ${paper.title}`, `<div class="edit-page"><section class="page-heading edit-heading"><h1>Edit metadata</h1><div class="edit-actions-top">${formActions(formId)}</div></section><section class="panel edit-panel">${renderPaperForm(paper, "edit", true)}${bibtexImportField(formId, paper.bibtex)}<hr><h2>Replace PDF</h2><form data-replace-upload data-paper-id="${paper.id}"><div class="inline-form"><input name="file" type="file" accept="application/pdf,.pdf" required><button class="button button-secondary form-utility-button edit-action-button" type="submit">${uploadIcon()}<span>Replace</span></button></div><p class="form-status" role="status"></p></form></section></div>`);
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

function renderScaleOption(value: string): string {
  return `<label class="width-option"><input type="radio" name="renderScale" value="${value}" data-theme-setting="renderScale"><span>${value}%</span></label>`;
}

function derivedColorPreview(): string {
  return `<div class="derived-color-preview" data-derived-color-preview aria-live="polite"><p class="derived-color-preview-title">Derived section colors</p><p class="muted">These update automatically with the selected background.</p><div class="derived-color-options"><div class="derived-color-option"><span class="derived-color-swatch" data-derived-color-swatch="sectionColor"></span><span><strong>Section headings</strong><code data-derived-color-value="sectionColor">#726e65</code></span></div><div class="derived-color-option"><span class="derived-color-swatch" data-derived-color-swatch="sectionSurface"></span><span><strong>Question surfaces</strong><code data-derived-color-value="sectionSurface">#faf9f7</code></span></div><div class="derived-color-option"><span class="derived-color-swatch derived-color-swatch-border" data-derived-color-swatch="sectionBorder"></span><span><strong>Dividers and borders</strong><code data-derived-color-value="sectionBorder">#d9d6ce</code></span></div></div></div>`;
}

export function renderHowToSection(): string {
  return `<details class="settings-group howto-group"><summary>HowTo</summary><div class="howto-body"><ol><li>Use <strong>Add paper</strong> to import by title, DOI, ISBN, arXiv ID, URL, or PDF.</li><li>Finding metadata or uploading a PDF saves the paper automatically; edit any fields afterward and changes are saved automatically.</li><li>Use search, tags, and filters to find papers; open a paper to edit metadata, replace its PDF, cite it, or generate analysis.</li><li>Use <strong>Settings</strong> for appearance, AI providers, and backups. Treat delete and replace actions as destructive and confirm them with the user.</li><li>When helping with computer use, follow visible labels, wait for status messages after actions, and report errors. Never invent metadata; ask before saving uncertain changes.</li></ol></div></details>`;
}

export function renderSettingsPage(): string {
  const body = `<section class="page-heading"><div><h1>Settings</h1></div></section>
  <section class="panel settings-page">
    ${renderHowToSection()}
    <div class="settings-group"><h2>Accent color</h2><div class="theme-options">${themeOption("accent", "forest", "Forest", "#315c52")}${themeOption("accent", "blue", "Blue", "#3d5a80")}${themeOption("accent", "terracotta", "Terracotta", "#9a4e36")}${themeOption("accent", "plum", "Plum", "#6b4c73")}${themeOption("accent", "slate", "Slate", "#58606a")}${customThemeOption("accent", "#315c52")}</div></div>
    <div class="settings-group"><h2>Background color</h2><div class="theme-options">${themeOption("background", "paper", "Paper", "#f7f6f2")}${themeOption("background", "white", "White", "#ffffff")}${themeOption("background", "light-gray", "Light gray", "#eeeeec")}${themeOption("background", "warm", "Warm", "#f3efe8")}${themeOption("background", "mint", "Mint", "#f6fdfa")}${customThemeOption("background", "#f7f6f2")}</div>${derivedColorPreview()}</div>
    <div class="settings-group"><h2>Content width</h2><p class="muted">Choose the width of the central content area on larger screens.</p><div class="width-options">${widthOption("50")}${widthOption("60")}${widthOption("70")}${widthOption("80")}${widthOption("90")}${widthOption("100")}</div></div>
    <div class="settings-group"><h2>Rendering scale</h2><p class="muted">Scale the complete interface to fit more content on smaller screens.</p><div class="width-options">${renderScaleOption("100")}${renderScaleOption("90")}${renderScaleOption("80")}${renderScaleOption("70")}${renderScaleOption("60")}${renderScaleOption("50")}</div></div>
    <div class="settings-group"><h2>Entries per page</h2><p class="muted">Choose how many papers appear on each library page.</p><div class="width-options">${pageSizeOption("5")}${pageSizeOption("7")}${pageSizeOption("10")}${pageSizeOption("25")}${pageSizeOption("50")}${pageSizeOption("100")}</div></div>
    <div class="settings-group"><h2>AI providers</h2><p class="muted">Choose the provider used for on-demand paper summaries, questions, and semantic library search.</p><form data-ai-settings><section class="settings-subsection active-provider-settings"><h3>Active provider</h3><label>Provider<select name="provider"><option value="openai">OpenAI</option><option value="ollama">Ollama</option></select></label></section><div class="ai-provider-columns"><section class="settings-subsection"><h3>OpenAI</h3><label>Model<select name="openaiModel"><option>gpt-5-nano</option><option>gpt-5.4-nano</option><option>gpt-5.4-mini</option><option>gpt-5.4</option><option>gpt-5.5</option><option>gpt-4.1-mini</option><option>gpt-4.1</option><option>gpt-4.1-nano</option><option>gpt-4o-mini</option><option>gpt-4o</option></select></label><label>Embedding model<input name="openaiEmbeddingModel" type="text" placeholder="text-embedding-3-small"></label><label>API key<input name="openaiApiKey" type="password" autocomplete="new-password" placeholder="Enter a replacement key"><span class="muted" data-openai-key-status>Checking key status…</span></label></section><section class="settings-subsection"><h3>Ollama</h3><label>Base URL<input name="ollamaBaseUrl" type="url" placeholder="http://localhost:11434"></label><label>Model<div class="field-with-action ollama-model-picker"><select name="ollamaModel" aria-label="Ollama model"><option value="">Choose an available model…</option></select><button class="icon-button" type="button" data-load-ollama-models aria-label="Refresh Ollama models" title="Refresh Ollama models">${refreshIcon()}</button></div><span class="muted" data-ollama-model-status>Select an Ollama URL to load available models.</span></label><label>Embedding model<input name="ollamaEmbeddingModel" type="text" placeholder="nomic-embed-text"></label></section></div><div class="ai-key-actions"><button class="button button-secondary" type="submit">Save AI settings</button><button class="button button-secondary" type="button" data-clear-openai-key>Clear OpenAI key</button></div><p class="form-status" data-ai-settings-status role="status"></p></form></div>
    <div class="settings-group"><h2>Backup and restore</h2><p class="muted">Download a ZIP64 snapshot containing your database and PDFs, or stage a snapshot to replace this library. Restart the app after restoring.</p><div class="backup-actions"><a class="button button-secondary" href="/api/export/backup">Download snapshot</a><form data-restore-backup><input class="sr-only" name="backup" type="file" accept="application/zip,.zip" required data-restore-backup-input><button class="button button-secondary" type="button" data-restore-backup-trigger>Restore snapshot</button><p class="form-status" role="status"></p></form></div></div>
    <div class="settings-group credits-group"><div class="credits-box"><h2>Credits</h2><p><strong>Ideation:</strong> Fabrizio Costa <a href="mailto:xfcosta@gmail.com">xfcosta@gmail.com</a></p><p><strong>Version:</strong> ${APP_VERSION_LABEL}</p></div></div>
  </section>`;
  return layout("Settings", body);
}
