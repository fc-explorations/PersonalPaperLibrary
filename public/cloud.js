const page = document.body.dataset.hostedPage || "library";

const themeStorageKey = "personal-paper-library-theme";
const accentThemes = { forest: ["#315c52", "#264b43", "#eaf0ed", "#aabbb4"], blue: ["#3d5a80", "#2d4665", "#e8eef5", "#aab9cb"], terracotta: ["#9a4e36", "#7d3d2b", "#f5e9e4", "#d8b6aa"], plum: ["#6b4c73", "#553b5c", "#eee8f0", "#c4b5c8"], slate: ["#58606a", "#434a52", "#edf0f2", "#b7bec4"] };
const backgroundThemes = { paper: "#f7f6f2", white: "#ffffff", "light-gray": "#eeeeec", warm: "#f3efe8", mint: "#f6fdfa" };
const pageSizes = [5, 7, 10, 25, 50, 100];
const renderScales = [100, 90, 80, 70, 60, 50];
function loadTheme() { try { return JSON.parse(localStorage.getItem(themeStorageKey) || "{}"); } catch { return {}; } }
function applyTheme(theme) {
  const accent = theme.accent === "custom" ? (theme.customAccent || "#315c52") : (accentThemes[theme.accent] || accentThemes.forest)[0];
  const accentSet = theme.accent === "custom" ? [accent, `color-mix(in srgb, ${accent} 82%, black 18%)`, `color-mix(in srgb, ${accent} 12%, white 88%)`, `color-mix(in srgb, ${accent} 48%, white 52%)`] : (accentThemes[theme.accent] || accentThemes.forest);
  const background = theme.background === "custom" ? (theme.customBackground || "#f7f6f2") : (backgroundThemes[theme.background] || backgroundThemes.paper);
  const renderScale = renderScales.includes(Number(theme.renderScale)) ? Number(theme.renderScale) : 100;
  document.documentElement.style.setProperty("--accent", accentSet[0]); document.documentElement.style.setProperty("--accent-dark", accentSet[1]); document.documentElement.style.setProperty("--accent-soft", accentSet[2]); document.documentElement.style.setProperty("--accent-border", accentSet[3]); document.documentElement.style.setProperty("--page-bg", background); document.documentElement.style.setProperty("--content-width", `${[50, 60, 70, 80, 90, 100].includes(Number(theme.contentWidth)) ? theme.contentWidth : 90}%`); document.documentElement.style.setProperty("--render-scale", String(renderScale / 100)); document.documentElement.style.setProperty("--render-width", `${10000 / renderScale}%`);
  document.querySelectorAll("[data-theme-setting]").forEach((input) => { const key = input.dataset.themeSetting; const selected = key === "accent" ? (accentThemes[input.value] ? (theme.accent || "forest") : theme.accent) : key === "background" ? (backgroundThemes[input.value] ? (theme.background || "paper") : theme.background) : key === "contentWidth" ? String(theme.contentWidth || 90) : key === "renderScale" ? String(renderScale) : String(theme.pageSize || 50); input.checked = input.value === selected; });
  document.querySelectorAll("[data-theme-picker]").forEach((input) => { input.value = input.dataset.themePicker === "accent" ? theme.customAccent || "#315c52" : theme.customBackground || "#f7f6f2"; });
}
let selectedTheme = loadTheme();
applyTheme(selectedTheme);
document.querySelectorAll("[data-theme-setting]").forEach((input) => input.addEventListener("change", () => { selectedTheme = { ...selectedTheme, [input.dataset.themeSetting]: input.value }; localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme)); applyTheme(selectedTheme); }));
document.querySelectorAll("[data-theme-picker]").forEach((input) => input.addEventListener("input", () => { const group = input.dataset.themePicker; selectedTheme = { ...selectedTheme, [group]: "custom", [group === "accent" ? "customAccent" : "customBackground"]: input.value }; localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme)); applyTheme(selectedTheme); }));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

function displayTagName(tag) {
  return String(tag).toLowerCase() === "no pdf" ? "NO PDF" : tag;
}

function updateOperationProgress(progress, finished, total) {
  if (!progress || !total) return;
  const percent = Math.min(100, Math.round((finished / total) * 100));
  progress.hidden = false;
  progress.setAttribute("aria-valuenow", String(percent));
  const fill = progress.querySelector("[data-operation-progress-fill], [data-bulk-progress-fill]");
  if (fill) fill.style.width = `${percent}%`;
}

function createOperationProgress(anchor) {
  const progress = document.createElement("div");
  progress.className = "operation-progress";
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Operation progress");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", "0");
  const fill = document.createElement("span");
  fill.dataset.operationProgressFill = "";
  progress.append(fill);
  anchor?.after(progress);
  return progress;
}

function operationEta(durations, remaining) {
  if (!remaining || !durations.length) return "";
  const average = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const seconds = Math.max(1, Math.ceil((average * remaining) / 1000));
  return seconds < 60 ? ` ETA ~${seconds}s remaining` : ` ETA ~${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""} remaining`;
}

async function enrichHostedPaperMetadata(current) {
  const paper = (await request(`/api/papers/${encodeURIComponent(current.id)}`)).paper;
  const input = paper.arxivId || paper.doi || paper.isbn || paper.title;
  const lookup = await request("/api/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input, paperId: paper.id }),
  });
  const metadata = lookup.paper || {};
  await request(`/api/papers/${encodeURIComponent(paper.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: metadata.title || paper.title,
      authors: metadata.authors?.length ? metadata.authors : paper.authors || [],
      year: metadata.year || paper.year,
      publishedDate: metadata.publishedDate || paper.publishedDate,
      abstract: metadata.abstract || paper.abstract,
      primaryCategory: metadata.primaryCategory || paper.primaryCategory,
      categories: metadata.categories?.length ? metadata.categories : paper.categories || [],
      journalRef: metadata.journalRef || paper.journalRef,
      acceptedVenue: metadata.acceptedVenue || paper.acceptedVenue,
      doi: metadata.doi || paper.doi,
      arxivId: metadata.arxivId || paper.arxivId,
      arxivUrl: metadata.arxivUrl || paper.arxivUrl,
      sourceUrl: metadata.sourceUrl || metadata.arxivUrl || paper.sourceUrl,
      tags: metadata.tags || paper.tags || [],
      metadataSource: metadata.metadataSource || "mixed",
      stagingToken: lookup.pdf?.stagingToken,
    }),
  });
  return lookup;
}

async function runHostedMetadataBatch(papers, { statusElement, progress, reload = false } = {}) {
  const uniquePapers = [...new Map(papers.filter(Boolean).map((paper) => [paper.id, paper])).values()];
  if (!uniquePapers.length) return { succeeded: 0, failed: 0 };
  const durations = [];
  let cursor = 0;
  let finished = 0;
  let succeeded = 0;
  let failed = 0;
  const update = () => {
    const remaining = uniquePapers.length - finished;
    if (statusElement) statusElement.textContent = `Finding metadata ${Math.min(finished + 1, uniquePapers.length)} of ${uniquePapers.length}…${operationEta(durations, remaining)}`;
    updateOperationProgress(progress, finished, uniquePapers.length);
  };
  update();
  const worker = async () => {
    while (cursor < uniquePapers.length) {
      const index = cursor++;
      const started = performance.now();
      try { await enrichHostedPaperMetadata(uniquePapers[index]); succeeded += 1; } catch { failed += 1; }
      durations.push(performance.now() - started);
      finished += 1;
      update();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, uniquePapers.length) }, () => worker()));
  updateOperationProgress(progress, uniquePapers.length, uniquePapers.length);
  if (statusElement) statusElement.textContent = `Metadata found for ${succeeded} of ${uniquePapers.length}${failed ? `; ${failed} failed.` : "."}`;
  if (reload) window.location.reload();
  return { succeeded, failed };
}

document.addEventListener("click", (event) => {
  const target = event.target;
  const link = target instanceof Element ? target.closest("[data-paper-pdf-link]") : null;
  if (!link?.href) return;
  event.preventDefault();
  window.open(link.href, "_blank", "noopener,noreferrer");
});

function renderHostedMarkdown(value) {
  const lines = String(value ?? "").replace(/\r\n/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = [];
  let code = [];
  let inCode = false;
  const inline = (text) => {
    const fragments = [];
    const protect = (fragment) => { const token = `\u0000${fragments.length}\u0000`; fragments.push(fragment); return token; };
    let protectedText = escapeHtml(text).replace(/`([^`]+)`/g, (_, codeText) => protect(`<code>${escapeHtml(codeText)}</code>`));
    protectedText = protectedText.replace(/(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)[^$\n]+?(?<!\\)\$)/g, (math) => protect(math));
    return protectedText.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/_([^_]+)_/g, "<em>$1</em>").replace(/\u0000(\d+)\u0000/g, (_, index) => fragments[Number(index)]);
  };
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${inline(paragraph.join(" "))}</p>`); paragraph = []; } };
  const flushList = () => { if (list.length) { output.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`); list = []; } };
  const flushCode = () => { if (code.length) { output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = []; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flushParagraph(); flushList(); if (inCode) flushCode(); inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushList(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
    const item = line.match(/^\s*[-*+]\s+(.+)$/) || line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (item) { flushParagraph(); list.push(item[1]); continue; }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList(); if (inCode) flushCode();
  return output.join("");
}

function typesetHostedMath(elements) {
  return new Promise((resolve) => {
    let attempts = 0;
    const typeset = () => {
      const mathJax = window.MathJax;
      if (typeof mathJax?.typesetPromise !== "function") {
        if (attempts++ < 200) window.setTimeout(typeset, 50);
        else resolve();
        return;
      }
      const run = () => { void mathJax.typesetPromise(elements).then(resolve, resolve); };
      if (mathJax.startup?.promise) void mathJax.startup.promise.then(run, resolve);
      else run();
    };
    typeset();
  });
}

typesetHostedMath([...document.querySelectorAll(".analysis-content, .abstract")]);

function renderHostedAnalysisMeta(summary) {
  if (!summary?.provider || !summary?.model || !summary?.generatedAt) return "";
  const duration = typeof summary.durationMs === "number"
    ? ` · ${Math.floor(summary.durationMs / 60000)}:${String(Math.floor(summary.durationMs / 1000) % 60).padStart(2, "0")}`
    : "";
  return `<p class="analysis-meta muted">${escapeHtml(summary.provider)} · ${escapeHtml(summary.model)} · ${escapeHtml(new Date(summary.generatedAt).toLocaleString("en-GB"))}${duration}</p>`;
}

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = body?.error?.message || `Request failed (${response.status})`;
    throw new Error(body?.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message);
  }
  return body;
}

async function requestWithLookupProgress(url, options = {}, onProgress) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/x-ndjson")) return requestResponse(response);
  const reader = response.body?.getReader();
  if (!reader) return requestResponse(response);
  const decoder = new TextDecoder();
  let buffer = "";
  let result;
  const consume = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === "progress") onProgress?.(event);
    if (event.type === "result") result = event;
  };
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consume);
  }
  consume(buffer);
  const body = result?.body || {};
  if (!result?.ok) throw new Error(body.error?.message || "Request failed");
  return body;
}

function looksLikeBibtex(input) {
  return /^\s*@\s*[a-z][a-z0-9_-]*\s*[({]/i.test(input);
}

async function resolveHostedFindInput(input, status) {
  const clean = input.trim();
  if (!looksLikeBibtex(clean)) return { input: clean };
  setStatus(status, "Parsing BibTeX…");
  const result = await request("/api/metadata/bibtex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bibtex: clean }) });
  const metadata = result.metadata || {};
  const lookupInput = String(metadata.doi || metadata.title || "").trim();
  if (!lookupInput) throw new Error("BibTeX entry must include a title or DOI.");
  return { input: lookupInput, bibtex: clean };
}

async function requestResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
}

function setLookupBusy(button, busy) {
  if (!button) return;
  const label = button.querySelector("span:last-child");
  if (busy) {
    button.dataset.lookupLabel ||= label?.textContent || "Find";
    if (label) label.textContent = "Finding…";
  } else if (label) label.textContent = button.dataset.lookupLabel || "Find";
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
}

function updateLookupProgress(button, event, formOrStatus) {
  const host = button?.closest(".form-actions") || button?.closest("form") || button?.parentElement;
  if (!host) return;
  let progress = host.querySelector("[data-lookup-progress]");
  if (!progress) {
    progress = createOperationProgress(host.querySelector(".form-status") || host.lastElementChild || host);
    progress.dataset.lookupProgress = "";
    progress.setAttribute("aria-label", "Metadata lookup progress");
  }
  progress.hidden = false;
  if (event.total) {
    progress.classList.remove("is-indeterminate");
    const phaseRange = { sources: [0, 70], enrichment: [70, 85], pdf: [85, 100] }[event.phase] || [0, 100];
    const percent = Math.min(100, Math.round(phaseRange[0] + (event.current / event.total) * (phaseRange[1] - phaseRange[0])));
    progress.setAttribute("aria-valuenow", String(percent));
    progress.querySelector("[data-operation-progress-fill]")?.style.setProperty("width", `${percent}%`);
  } else progress.classList.add("is-indeterminate");
  if (event.message) setStatus(formOrStatus, event.message);
}

function clearLookupProgress(button) {
  const host = button?.closest(".form-actions") || button?.closest("form") || button?.parentElement;
  const progress = host?.querySelector("[data-lookup-progress]");
  if (progress) progress.hidden = true;
}

function requestWithUploadProgress(url, options = {}, { onProgress, onUploadComplete } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options.method || "GET", url);
    xhr.withCredentials = true;
    Object.entries(options.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.upload.onload = () => onUploadComplete?.();
    xhr.onload = () => {
      const contentType = xhr.getResponseHeader("content-type") || "";
      let body = contentType.includes("application/json") ? {} : xhr.responseText;
      try { if (contentType.includes("application/json")) body = JSON.parse(xhr.responseText || "{}"); } catch { /* The normal error below is more useful than a parse error. */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = body?.error?.message || `Request failed (${xhr.status})`;
        reject(new Error(body?.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message));
        return;
      }
      resolve(body);
    };
    xhr.onerror = () => reject(new Error("The library server connection failed. Check that it is running, then retry."));
    xhr.ontimeout = () => reject(new Error("Request timed out."));
    xhr.send(options.body);
  });
}

function setStatus(element, message, error = false) {
  if (!element) return;
  const status = element.matches?.(".form-status, [role='status']")
    ? element
    : element.querySelector?.(".form-status, [role='status']");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("status-error", error);
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function pollUntil(load, done, timeout = 120000, interval = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await load();
    if (done(value)) return value;
    await sleep(interval);
  }
  throw new Error("The analysis job is taking longer than expected. Refresh to check its status.");
}

function showAnalysisResult(element, heading, content, error = false) {
  if (!element) return;
  element.className = `analysis-result${error ? " status-error" : ""}`;
  element.innerHTML = `<strong>${escapeHtml(heading)}</strong><div class="analysis-content">${renderHostedMarkdown(content)}</div>`;
  element.hidden = false;
  typesetHostedMath([element]);
}

async function runSummary(paperId, onUpdate, mode = "quick") {
  onUpdate("Summary", "Queued…");
  await request(`/api/papers/${encodeURIComponent(paperId)}/summary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
  const progress = await pollUntil(
    () => request(`/api/papers/${encodeURIComponent(paperId)}/summary/progress`),
    (value) => !value.job || ["complete", "error", "cancelled"].includes(value.job.status),
  );
  if (!progress.job || progress.job.status !== "complete") throw new Error(progress.job?.errorMessage || "Summary generation failed.");
  const summary = await request(`/api/papers/${encodeURIComponent(paperId)}/summary`);
  await onUpdate("Summary", summary.summary?.content || "The summary completed without content.", summary.summary);
}

function markHostedSummaryComplete() {
  const dot = document.querySelector("[data-summary-section] .analysis-progress-dot");
  if (!dot) return;
  dot.classList.add("is-complete");
  dot.setAttribute("aria-label", "Summary available");
  dot.setAttribute("title", "Summary available");
}

async function runQuestion(paperId, question, onUpdate) {
  onUpdate("Answer", "Queued…");
  const queued = await request(`/api/papers/${encodeURIComponent(paperId)}/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: question.trim(), prompt: question.trim() }) });
  const questionId = queued.question?.id;
  if (!questionId) throw new Error("The question was not queued.");
  const answer = await pollUntil(
    async () => (await request(`/api/papers/${encodeURIComponent(paperId)}/questions`)).questions.find((item) => item.id === questionId),
    (value) => value?.answer && ["complete", "error", "stale"].includes(value.answer.status),
  );
  if (!answer?.answer || answer.answer.status !== "complete") throw new Error(answer?.answer?.errorMessage || "Question generation failed.");
  onUpdate("Answer", answer.answer.content);
}

function libraryState() {
  const params = new URLSearchParams(window.location.search);
  return { q: params.get("q") || "", sort: params.get("sort") || "newest", tags: params.getAll("tag"), selected: params.getAll("selected"), tagMode: params.get("tagMode") === "and" ? "and" : "or", untagged: params.get("untagged") === "1", page: Math.max(1, Number(params.get("page") || 1) || 1), pageSize: pageSizes.includes(Number(selectedTheme.pageSize)) ? Number(selectedTheme.pageSize) : 50 };
}

function libraryUrl(state, changes = {}) {
  const next = { ...state, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.sort && next.sort !== "newest") params.set("sort", next.sort);
  (next.tags || []).forEach((tag) => params.append("tag", tag));
  (next.selected || []).forEach((id) => params.append("selected", id));
  if (next.tagMode && next.tagMode !== "or") params.set("tagMode", next.tagMode);
  if (next.untagged) params.set("untagged", "1");
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function hostedLibrarySelectionUrl(ids) {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append("selected", id));
  return `/?${params}`;
}

function paperCard(paper) {
  const tags = (paper.tags || []).map((tag) => `<a class="tag" href="${libraryUrl(libraryState(), { tags: [tag], untagged: false, page: 1 })}">${escapeHtml(displayTagName(tag))}</a>`).join(" ");
  const authors = paper.authors || [];
  const authorLine = authors.length <= 3 ? authors.join(", ") : `${authors.slice(0, 3).join(", ")} et al.`;
  const venue = paper.acceptedVenue || paper.journalRef || "";
  const sourceUrl = paper.arxivId ? (paper.arxivUrl || `https://arxiv.org/abs/${paper.arxivId}`) : paper.sourceUrl || (paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "");
  const sourceLabel = paper.arxivId ? `arXiv:${paper.arxivId}` : paper.doi ? `DOI:${paper.doi}` : sourceUrl ? "Source" : "";
  const meta = [`<span class="paper-authors">${escapeHtml(authorLine || "No authors recorded")}</span>`, venue ? escapeHtml(venue) : "", paper.year ? String(paper.year) : "", sourceUrl ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(sourceLabel)}</a>` : ""].filter(Boolean).join(" · ");
  const selected = libraryState().selected.includes(paper.id);
  return `<article class="paper-card"><label class="paper-select"><input type="checkbox" data-select-paper="${escapeHtml(paper.id)}" aria-label="Select ${escapeHtml(paper.title)}"${selected ? " checked" : ""}></label><div class="paper-card-main"><h2><a href="/papers/${encodeURIComponent(paper.id)}">${escapeHtml(paper.title)}</a></h2><p class="paper-meta muted">${meta}</p></div>${tags ? `<div class="paper-tags">${tags}</div>` : ""}</article>`;
}

function renderLibraryTags(tags, state) {
  const noPdfTag = tags.find((tag) => tag.toLowerCase() === "no pdf") || "no pdf";
  const customTags = tags.filter((tag) => tag.toLowerCase() !== "no pdf");
  const tagLinks = customTags.map((tag) => {
    const selected = state.tags.some((value) => value.toLowerCase() === tag.toLowerCase());
    const nextTags = selected ? state.tags.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...state.tags, tag];
    return `<a class="tag${selected ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: nextTags, untagged: false, page: 1 })}" aria-pressed="${selected}">${escapeHtml(displayTagName(tag))}</a>`;
  }).join(" ");
  const noPdfSelected = state.tags.some((tag) => tag.toLowerCase() === noPdfTag.toLowerCase());
  const noPdfTags = noPdfSelected ? state.tags.filter((tag) => tag.toLowerCase() !== noPdfTag.toLowerCase()) : [...state.tags, noPdfTag];
  const noPdfLink = `<a class="tag${noPdfSelected ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: noPdfTags, untagged: false, page: 1 })}" aria-pressed="${noPdfSelected}">NO PDF</a>`;
  const allSelected = !state.tags.length && !state.untagged;
  return `<span class="tag-mode-label">Match:</span> <a class="tag tag-mode-button${state.tagMode === "and" ? " tag-selected" : ""}" href="${libraryUrl(state, { tagMode: "and", page: 1 })}">AND</a> <a class="tag tag-mode-button${state.tagMode === "or" ? " tag-selected" : ""}" href="${libraryUrl(state, { tagMode: "or", page: 1 })}">OR</a> <span class="tag-mode-label">Tags:</span> <a class="tag${allSelected ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: [], untagged: false, page: 1 })}">ALL</a> <a class="tag${state.untagged ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: [], untagged: !state.untagged, page: 1 })}">NONE</a> ${noPdfLink} ${tagLinks}`;
}

let hostedLibraryView = { body: null, state: null, tags: [] };

function hasLibraryFilter(state) {
  return Boolean(state?.q || state?.tags?.length || state?.untagged);
}

function libraryExportUrl(state, selectedIds = []) {
  const params = new URLSearchParams();
  if (state?.q) params.set("q", state.q);
  (state?.tags || []).forEach((tag) => params.append("tag", tag));
  if (state?.tagMode === "and") params.set("tagMode", "and");
  if (state?.untagged) params.set("untagged", "1");
  selectedIds.forEach((id) => params.append("selected", id));
  return `/api/export/pdfs?${params}`;
}

function libraryBibtexUrl(state, selectedIds = []) {
  const params = new URLSearchParams();
  if (state?.q) params.set("q", state.q);
  (state?.tags || []).forEach((tag) => params.append("tag", tag));
  if (state?.tagMode === "and") params.set("tagMode", "and");
  if (state?.untagged) params.set("untagged", "1");
  selectedIds.forEach((id) => params.append("selected", id));
  return `/api/export/bibtex?${params}`;
}

function bulkTagEditor(context, tags) {
  const options = tags.map((tag) => `<option value="${escapeHtml(tag)}">${escapeHtml(displayTagName(tag))}</option>`).join("");
  return `<div class="bulk-tag-editor" data-bulk-tag-editor hidden><form data-bulk-tag-form data-selection-query="${escapeHtml(context.q || "")}" data-selection-tags="${escapeHtml(JSON.stringify(context.tags || []))}" data-selection-tag-mode="${escapeHtml(context.tagMode || "or")}" data-selection-untagged="${context.untagged ? "true" : "false"}" data-selection-ids="${escapeHtml(JSON.stringify(context.selectedIds || []))}"><label>Tag to apply<div class="bulk-tag-fields"><select name="tag" data-bulk-tag-select required><option value="">Choose a tag…</option>${options}<option value="__new__">New tag…</option></select><input name="newTag" data-new-tag placeholder="New tag name" hidden></div></label><div class="bulk-tag-actions"><button class="button button-secondary" type="submit" data-bulk-tag-action="add"><span class="material-symbols-outlined" aria-hidden="true">add</span><span>Add tag</span></button><button class="button button-danger" type="submit" data-bulk-tag-action="remove"><span class="material-symbols-outlined" aria-hidden="true">delete</span><span>Remove tag</span></button><button class="button button-secondary" type="button" data-cancel-bulk-tags><span class="material-symbols-outlined" aria-hidden="true">close</span><span>Cancel</span></button></div><p class="form-status" role="status"></p></form></div>`;
}

function groupActions(body, state, tags, selectedIds = []) {
  const group = selectedIds.length ? false : hasLibraryFilter(state);
  if (!body?.total || (!group && !selectedIds.length)) return "";
  const context = { q: group ? state.q : "", tags: group ? state.tags : [], tagMode: group ? state.tagMode : "or", untagged: group ? state.untagged : false, selectedIds };
  const count = selectedIds.length || body.total;
  const stored = selectedIds.length ? body.papers.filter((paper) => paper.r2Key).length : body.stored;
  const label = selectedIds.length ? `Delete selected (${count})` : state.tags.length || state.untagged ? "Delete group" : "Delete selected";
  const toolbar = `<div class="bulk-actions" data-bulk-toolbar>${selectedIds.length ? `<button class="button button-secondary" type="button" data-batch-metadata data-batch-metadata-ids="${escapeHtml(JSON.stringify(selectedIds))}"><span class="material-symbols-outlined" aria-hidden="true">search</span><span>Find metadata</span></button>` : ""}<button class="button button-secondary" type="button" data-toggle-bulk-tags aria-expanded="false"><span class="material-symbols-outlined" aria-hidden="true">edit</span><span>Edit tags</span></button><a class="button button-secondary" href="${libraryBibtexUrl(context, selectedIds)}"><span class="material-symbols-outlined" aria-hidden="true">download</span><span>Export BibTeX</span></a>${stored ? `<a class="button button-secondary" href="${libraryExportUrl(context, selectedIds)}"><span class="material-symbols-outlined" aria-hidden="true">download</span><span>Download ${stored} PDF${stored === 1 ? "" : "s"}</span></a>` : ""}<button class="button button-danger" type="button" data-delete-group data-delete-query="${escapeHtml(context.q)}" data-delete-tags="${escapeHtml(JSON.stringify(context.tags))}" data-delete-tag-mode="${escapeHtml(context.tagMode)}" data-delete-untagged="${context.untagged ? "true" : "false"}" data-delete-selected-ids="${escapeHtml(JSON.stringify(selectedIds))}" data-delete-count="${count}"><span class="material-symbols-outlined" aria-hidden="true">delete</span><span>${label}</span></button></div>`;
  return `<div class="hosted-bulk-group" data-hosted-bulk>${toolbar}${bulkTagEditor(context, tags)}</div>`;
}

function renderPagination(state, total) {
  const pageCount = Math.max(1, Math.ceil(total / state.pageSize));
  if (pageCount <= 1) return "";
  const pages = Array.from({ length: pageCount }, (_, index) => index + 1).slice(0, 9).map((page) => `<a class="button button-secondary button-small page-number${page === state.page ? '" aria-current="page' : ""}" href="${libraryUrl(state, { page })}">${page}</a>`).join("");
  return `<span class="muted pagination-summary">Page ${state.page} of ${pageCount}</span><nav class="pagination" aria-label="Paper pages"><a class="button button-secondary button-small" href="${libraryUrl(state, { page: 1 })}">First</a><a class="button button-secondary button-small" href="${libraryUrl(state, { page: Math.max(1, state.page - 1) })}">Previous</a><span class="pagination-pages">${pages}</span><a class="button button-secondary button-small" href="${libraryUrl(state, { page: Math.min(pageCount, state.page + 1) })}">Next</a><a class="button button-secondary button-small" href="${libraryUrl(state, { page: pageCount })}">Last</a></nav>`;
}

async function loadPapers() {
  const list = document.querySelector("#paper-list");
  const listStatus = document.querySelector("#list-status");
  if (!list || !listStatus) return;
  const state = libraryState();
  const search = document.querySelector("#search");
  const sort = document.querySelector("#sort");
  if (search) search.value = state.q;
  if (sort) sort.value = state.sort;
  setStatus(listStatus, "Loading…");
  try {
    const params = new URLSearchParams({ limit: String(state.pageSize), offset: String((state.page - 1) * state.pageSize), sort: state.sort, tagMode: state.tagMode });
    if (state.q) params.set("q", state.q);
    state.tags.forEach((tag) => params.append("tag", tag));
    state.selected.forEach((id) => params.append("selected", id));
    if (state.untagged) params.set("untagged", "1");
    const [body, tagBody] = await Promise.all([request(`/api/papers?${params}`), request("/api/tags")]);
    const pageCount = Math.max(1, Math.ceil(body.total / state.pageSize));
    if (body.total && state.page > pageCount) return window.location.replace(libraryUrl(state, { page: pageCount }));
    document.querySelector("#library-tags").innerHTML = renderLibraryTags(tagBody.tags || [], state);
    hostedLibraryView = { body, state, tags: tagBody.tags || [] };
    list.className = `paper-list${body.papers.length ? "" : " empty-paper-list"}`;
    list.innerHTML = body.papers.length ? body.papers.map(paperCard).join("") : `<div class="empty-state"><h2>${state.q || state.tags.length || state.untagged ? "No papers found" : "No papers yet"}</h2><p class="muted">Add a paper or upload a PDF to start your collection.</p><a class="button" href="/add">Add your first paper</a></div>`;
    setStatus(listStatus, `${body.total} paper${body.total === 1 ? "" : "s"}`);
    const pagination = document.querySelector("#library-pagination");
    pagination.innerHTML = renderPagination(state, body.total);
    pagination.hidden = !pagination.innerHTML;
    updateBulkState();
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    setStatus(listStatus, "Could not load the library", true);
  }
}

function updateBulkState() {
  const list = document.querySelector("#paper-list");
  const actions = document.querySelector("#bulk-actions");
  if (!list || !actions) return;
  const selected = list.querySelectorAll("[data-select-paper]:checked").length;
  const selectedIds = [...list.querySelectorAll("[data-select-paper]:checked")].map((input) => input.dataset.selectPaper).filter(Boolean);
  actions.innerHTML = groupActions(hostedLibraryView.body, hostedLibraryView.state, hostedLibraryView.tags, selectedIds);
  actions.hidden = !actions.innerHTML;
}

function initLibrary() {
  const list = document.querySelector("#paper-list");
  const form = document.querySelector("#library-search-form");
  if (!list || !form) return;
  list.addEventListener("change", (event) => { if (event.target.closest("[data-select-paper]")) updateBulkState(); });
  document.querySelector("#bulk-actions")?.addEventListener("click", async (event) => {
    const ids = [...list.querySelectorAll("[data-select-paper]:checked")].map((input) => input.dataset.selectPaper).filter(Boolean);
    const target = event.target.closest("button");
    if (!target) return;
    if (target.matches("[data-batch-metadata]")) {
      const selectedPapers = JSON.parse(target.dataset.batchMetadataIds || "[]").map((id) => hostedLibraryView.body?.papers.find((paper) => paper.id === id)).filter(Boolean);
      target.disabled = true;
      try {
        await runHostedMetadataBatch(selectedPapers, { statusElement: document.querySelector("#list-status"), progress: createOperationProgress(document.querySelector("#list-status")), reload: true });
      } catch (error) {
        setStatus(document.querySelector("#list-status"), error.message, true);
        target.disabled = false;
      }
      return;
    }
    if (target.matches("[data-toggle-bulk-tags]")) {
      const editor = document.querySelector("[data-bulk-tag-editor]");
      const toolbar = document.querySelector("[data-bulk-toolbar]");
      if (editor) editor.hidden = false;
      if (toolbar) toolbar.hidden = true;
      target.setAttribute("aria-expanded", "true");
      editor?.querySelector("select")?.focus();
      return;
    }
    if (target.matches("[data-cancel-bulk-tags]")) {
      const editor = document.querySelector("[data-bulk-tag-editor]");
      const toolbar = document.querySelector("[data-bulk-toolbar]");
      if (editor) editor.hidden = true;
      if (toolbar) toolbar.hidden = false;
      document.querySelector("[data-toggle-bulk-tags]")?.setAttribute("aria-expanded", "false");
      return;
    }
    if (!target.matches("[data-delete-group]")) return;
    const count = target.dataset.deleteCount || String(ids.length);
    if (!confirm(`Delete ${count} paper${Number(count) === 1 ? "" : "s"} and their PDFs?`)) return;
    target.disabled = true;
    const body = { q: target.dataset.deleteQuery || undefined, tags: JSON.parse(target.dataset.deleteTags || "[]"), tagMode: target.dataset.deleteTagMode || "or", untagged: target.dataset.deleteUntagged === "true", selectedIds: JSON.parse(target.dataset.deleteSelectedIds || "[]") };
    try { setStatus(document.querySelector("#list-status"), `Deleting ${count} paper${Number(count) === 1 ? "" : "s"}…`); await request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); await loadPapers(); }
    catch (error) { setStatus(document.querySelector("#list-status"), error.message, true); target.disabled = false; }
  });
  document.querySelector("#bulk-actions")?.addEventListener("change", (event) => { if (!event.target.matches("[data-bulk-tag-select]")) return; const form = event.target.closest("form"); const input = form?.querySelector("[data-new-tag]"); const isNew = event.target.value === "__new__"; if (input) { input.hidden = !isNew; input.required = isNew; if (isNew) input.focus(); } });
  document.querySelector("#bulk-actions")?.addEventListener("submit", async (event) => { const form = event.target.closest("[data-bulk-tag-form]"); if (!form) return; event.preventDefault(); const action = event.submitter?.dataset.bulkTagAction; const selected = form.elements.namedItem("tag").value; const name = selected === "__new__" ? form.elements.namedItem("newTag").value : selected; if (action === "remove" && selected === "__new__") { setStatus(form, "Choose an existing tag to remove.", true); return; } if (!name?.trim()) { setStatus(form, "Choose or enter a tag.", true); return; } setStatus(form, "Updating tags…"); try { await request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: form.dataset.selectionQuery || undefined, tags: JSON.parse(form.dataset.selectionTags || "[]"), tagMode: form.dataset.selectionTagMode || "or", untagged: form.dataset.selectionUntagged === "true", selectedIds: JSON.parse(form.dataset.selectionIds || "[]"), name, action }) }); await loadPapers(); } catch (error) { setStatus(form, error.message, true); } });
  form.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(form); window.location.href = libraryUrl(libraryState(), { q: String(data.get("q") || "").trim(), sort: String(data.get("sort") || "newest"), page: 1 }); });
  form.querySelector("select[name=sort]")?.addEventListener("change", () => form.requestSubmit());
  const clear = document.querySelector("[data-clear-search]");
  const search = document.querySelector("#search");
  const updateClear = () => { if (clear) clear.hidden = !search?.value; };
  search?.addEventListener("input", updateClear); clear?.addEventListener("click", () => { if (search) search.value = ""; updateClear(); }); updateClear();
  loadPapers();
}

let hostedStaged;

function applyHostedMetadata(form, data) {
  if (!form) return;
  const paper = data.paper || {};
  const setValue = (name, value) => { const input = form.elements.namedItem(name); if (input) input.value = value || ""; };
  if (data.partialMetadata) {
    setValue("title", paper.title);
    setValue("isbn", paper.isbn);
    return;
  }
  setValue("title", paper.title);
  setValue("authors", (paper.authors || []).join("\n"));
  setValue("year", paper.year);
  setValue("publishedDate", paper.publishedDate);
  if (paper.abstract?.trim()) setValue("abstract", paper.abstract);
  setValue("primaryCategory", paper.primaryCategory);
  setValue("categories", (paper.categories || []).join(", "));
  setValue("journalRef", paper.journalRef);
  setValue("acceptedVenue", paper.acceptedVenue);
  setValue("doi", paper.doi);
  setValue("isbn", paper.isbn);
  setValue("bibtex", paper.bibtex);
  setValue("arxivId", paper.arxivId);
  setValue("sourceUrl", paper.sourceUrl || paper.arxivUrl);
  if (paper.tags) setValue("tags", paper.tags.join(", "));
  const existingStagingToken = form.elements.namedItem("stagingToken")?.value || "";
  const activeStagingToken = data.pdf?.stagingToken || existingStagingToken;
  setValue("stagingToken", activeStagingToken);
  const stagedPdfLink = form.querySelector("[data-paper-pdf-link]");
  if (stagedPdfLink) {
    const storedPdf = form.dataset.mode === "edit" && data.pdf?.status === "preserved" && form.dataset.paperId;
    stagedPdfLink.hidden = !activeStagingToken && !storedPdf;
    if (activeStagingToken) stagedPdfLink.href = `/api/staging/${encodeURIComponent(activeStagingToken)}/pdf`;
    else if (storedPdf) stagedPdfLink.href = `/api/papers/${encodeURIComponent(form.dataset.paperId)}/pdf`;
  }
  const sourceUrl = form.querySelector("[data-source-url-go]");
  const source = paper.sourceUrl || paper.arxivUrl || (paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "");
  if (sourceUrl) { sourceUrl.hidden = !/^https?:\/\//i.test(source); if (!sourceUrl.hidden) sourceUrl.href = source; }
}

function applyHostedBibtex(form, metadata) {
  if (!form) return;
  const setIfPresent = (name, value) => { const input = form.elements.namedItem(name); if (input && value) input.value = value; };
  setIfPresent("title", metadata.title);
  if (metadata.authors?.length) setIfPresent("authors", metadata.authors.join("\n"));
  setIfPresent("year", metadata.year);
  setIfPresent("publishedDate", metadata.publishedDate);
  setIfPresent("abstract", metadata.abstract);
  setIfPresent("primaryCategory", metadata.primaryCategory);
  if (metadata.categories?.length) setIfPresent("categories", metadata.categories.join(", "));
  setIfPresent("journalRef", metadata.journalRef);
  setIfPresent("acceptedVenue", metadata.acceptedVenue);
  setIfPresent("doi", metadata.doi);
  setIfPresent("isbn", metadata.isbn);
  setIfPresent("arxivId", metadata.arxivId);
  setIfPresent("sourceUrl", metadata.sourceUrl || metadata.arxivUrl);
  setIfPresent("bibtex", metadata.bibtex);
  const sourceUrl = form.querySelector("[data-source-url-go]");
  const source = metadata.sourceUrl || metadata.arxivUrl || (metadata.doi ? `https://doi.org/${encodeURIComponent(metadata.doi)}` : "");
  if (sourceUrl) { sourceUrl.hidden = !/^https?:\/\//i.test(source); if (!sourceUrl.hidden) sourceUrl.href = source; }
}

function renderHostedPreview(data) {
  const preview = document.querySelector("#import-preview");
  if (!preview) return;
  hostedStaged = data;
  const form = document.querySelector("#paper-form-new");
  applyHostedMetadata(form, data);
  const paper = data.paper || {};
  const activeStagingToken = form?.elements.namedItem("stagingToken")?.value || "";
  const source = paper.sourceUrl || paper.arxivUrl || (paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "");
  const webResource = preview.querySelector("[data-web-resource]");
  if (webResource) { webResource.hidden = Boolean(activeStagingToken) || !/^https?:\/\//i.test(source); if (!webResource.hidden) webResource.href = source; }
  const pdfStatus = document.querySelector("#import-pdf-status");
  if (pdfStatus) pdfStatus.textContent = data.pdf?.status === "staged" ? "PDF staged" : "Metadata only";
  const warnings = preview.querySelector("[data-warnings]");
  if (warnings) warnings.textContent = (data.warnings || []).join(" ");
  preview.hidden = false;
  preview.scrollIntoView({ behavior: "smooth", block: "start" });
}

function hostedPaperBody(form) {
  const get = (name) => form.elements.namedItem(name)?.value || "";
  return {
    title: get("title"), authors: get("authors").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean),
    year: get("year") || undefined, publishedDate: get("publishedDate"), abstract: get("abstract"),
    primaryCategory: get("primaryCategory"), categories: get("categories").split(",").map((value) => value.trim()).filter(Boolean),
    journalRef: get("journalRef"), acceptedVenue: get("acceptedVenue"), doi: get("doi"), isbn: get("isbn"), arxivId: get("arxivId"),
    sourceUrl: get("sourceUrl"), bibtex: get("bibtex"), tags: get("tags").split(",").map((value) => value.trim()).filter(Boolean),
    stagingToken: get("stagingToken"), metadataSource: get("arxivId") ? "mixed" : "manual",
  };
}

async function saveHostedPaperForm(form, { redirect = false, statusMessage = "Saved." } = {}) {
  const status = document.querySelector(`[data-form-status-for="${form.id}"]`);
  setStatus(status, "Saving…");
  try {
    const editing = form.dataset.mode === "edit" && form.dataset.paperId;
    const saved = await request(editing ? `/api/papers/${encodeURIComponent(form.dataset.paperId)}` : "/api/papers", { method: editing ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...hostedPaperBody(form), ...(editing ? { id: form.dataset.paperId } : {}) }) });
    if (!editing && saved.paper?.id) {
      form.dataset.mode = "edit";
      form.dataset.paperId = saved.paper.id;
      enableHostedPaperAutosave(form);
    }
    const stagingToken = form.elements.namedItem("stagingToken");
    if (stagingToken) stagingToken.value = "";
    const paperPdfLink = form.querySelector("[data-paper-pdf-link]");
    if (paperPdfLink && saved.paper?.id) {
      paperPdfLink.hidden = !saved.paper.r2Key;
      if (saved.paper.r2Key) paperPdfLink.href = `/api/papers/${encodeURIComponent(saved.paper.id)}/pdf`;
    }
    if (redirect) {
      const destination = redirect === "edit" ? `/papers/${encodeURIComponent(saved.paper.id)}/edit` : `/papers/${encodeURIComponent(saved.paper.id)}`;
      window.location.href = destination;
    }
    else setStatus(status, statusMessage);
    return saved;
  } catch (error) {
    setStatus(status, error.message, true);
    return null;
  }
}

document.querySelectorAll("[data-paper-form]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveHostedPaperForm(form);
}));

const hostedAutosaveStates = new WeakMap();
const hostedAutosaveForms = new WeakSet();
function scheduleHostedPaperAutosave(form, delay = 650) {
  if (form.dataset.mode !== "edit") return;
  const state = hostedAutosaveStates.get(form) || { timer: 0, saving: false, queued: false };
  state.queued = true;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(async () => {
    if (state.saving) return;
    state.saving = true;
    state.queued = false;
    await saveHostedPaperForm(form);
    state.saving = false;
    if (state.queued) scheduleHostedPaperAutosave(form, 0);
  }, delay);
  hostedAutosaveStates.set(form, state);
}

function enableHostedPaperAutosave(form) {
  if (!form || hostedAutosaveForms.has(form)) return;
  hostedAutosaveForms.add(form);
  form.addEventListener("input", () => scheduleHostedPaperAutosave(form));
  form.addEventListener("change", () => scheduleHostedPaperAutosave(form, 0));
}

document.querySelectorAll("[data-paper-form][data-mode='edit']").forEach(enableHostedPaperAutosave);
document.querySelectorAll("[data-bibtex-import]").forEach((input) => {
  const form = document.querySelector(`#${input.getAttribute("form")}`) || input.closest("[data-paper-form]");
  if (!form || form.dataset.mode !== "edit") return;
  input.addEventListener("input", () => scheduleHostedPaperAutosave(form));
  input.addEventListener("change", () => scheduleHostedPaperAutosave(form, 0));
});

document.querySelectorAll("[data-lookup-metadata]").forEach((button) => button.addEventListener("click", async () => {
  const form = document.querySelector(`#${button.getAttribute("form") || "paper-form-new"}`);
  const status = document.querySelector(`[data-form-status-for="${form?.id}"]`);
  if (!form) return;
  const get = (name) => form.elements.namedItem(name)?.value || "";
  const input = get("arxivId") || get("doi") || get("isbn") || get("title");
  if (!input.trim()) return setStatus(status, "Enter a title, DOI, ISBN, or arXiv ID first.", true);
  setLookupBusy(button, true);
  try {
    setStatus(status, "Looking up citation metadata…");
    const body = await requestWithLookupProgress("/api/import?progress=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, title: get("title"), paperId: form.dataset.mode === "edit" ? form.dataset.paperId : undefined, stagingToken: get("stagingToken") || undefined, tags: get("tags").split(",").map((value) => value.trim()).filter(Boolean) }) }, (progress) => updateLookupProgress(button, progress, status));
    if (body.duplicate) throw new Error("That paper is already in the library.");
    if (form.dataset.mode === "edit") {
      applyHostedMetadata(form, body);
      const statusMessage = body.warnings?.length
        ? `${get("isbn").trim() ? "ISBN retained and saved. " : ""}${body.warnings.join(" ")}`
        : "Metadata found and saved.";
      await saveHostedPaperForm(form, { statusMessage });
    } else {
      renderHostedPreview(body);
      const saved = await saveHostedPaperForm(form, { redirect: "edit", statusMessage: body.warnings?.length ? body.warnings.join(" ") : "Metadata found and saved." });
      setStatus(status, saved ? "Metadata found and saved." : "Metadata found. Fix the error below and retry.", !saved);
    }
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    clearLookupProgress(button);
    setLookupBusy(button, false);
  }
}));

document.querySelectorAll("[data-import-bibtex]").forEach((button) => button.addEventListener("click", async () => {
  const panel = button.closest(".bibtex-import");
  const form = document.querySelector(`#${button.getAttribute("form")}`) || button.closest("[data-paper-form]");
  const input = panel?.querySelector("[data-bibtex-import]");
  const status = panel?.querySelector("[data-bibtex-status]");
  if (!form || !input || !status) return;
  if (!input.value.trim()) { status.textContent = "Paste a BibTeX entry first."; status.classList.add("status-error"); return; }
  button.disabled = true;
  status.classList.remove("status-error");
  status.textContent = "Parsing BibTeX…";
  try {
    const result = await request("/api/metadata/bibtex", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bibtex: input.value }) });
    applyHostedBibtex(form, result.metadata || {});
    await saveHostedPaperForm(form, { statusMessage: "BibTeX imported and saved." });
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("status-error");
  } finally {
    button.disabled = false;
  }
}));

document.querySelectorAll("[data-extract-abstract]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.closest("[data-paper-form]");
  const status = document.querySelector(`[data-form-status-for="${form?.id}"]`);
  const stagingToken = form?.elements.namedItem("stagingToken")?.value || "";
  const paperId = form?.dataset.mode === "edit" ? form.dataset.paperId : "";
  if (!stagingToken && !paperId) return setStatus(status, "Upload or stage a PDF before extracting its abstract.", true);
  button.disabled = true;
  try {
    setStatus(status, "Extracting the abstract from the PDF…");
    const body = await request("/api/abstract/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stagingToken: stagingToken || undefined, paperId: paperId || undefined }) });
    form.elements.namedItem("abstract").value = body.abstract || "";
    await saveHostedPaperForm(form, { statusMessage: "Abstract extracted and saved." });
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    button.disabled = false;
  }
}));

function renderHostedTagSuggestions(form, suggestions, provider, model) {
  const panel = form.querySelector("[data-tag-suggestions]");
  const list = panel?.querySelector("[data-tag-suggestion-list]");
  if (!panel || !list) return;
  panel.hidden = false;
  const status = panel.querySelector("[data-tag-suggestions-status]");
  if (status) status.textContent = `${provider} · ${model}`;
  list.innerHTML = suggestions.length ? suggestions.map((suggestion) => `<label class="tag-suggestion"><input type="checkbox" checked data-tag-suggestion data-tag-name="${escapeHtml(suggestion.name)}"><span class="tag-suggestion-name">${escapeHtml(suggestion.name)}</span><span class="tag-suggestion-kind">${suggestion.existing ? "Existing" : "New"}</span>${suggestion.reason ? `<span class="tag-suggestion-reason">${escapeHtml(suggestion.reason)}</span>` : ""}</label>`).join("") : `<p class="muted">No specific tags were found for this abstract.</p>`;
  const apply = panel.querySelector("[data-apply-tag-suggestions]");
  if (apply) apply.hidden = !suggestions.length;
}

document.querySelectorAll("[data-suggest-tags]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.closest("[data-paper-form]");
  const status = document.querySelector(`[data-form-status-for="${form?.id}"]`);
  const get = (name) => form?.elements.namedItem(name)?.value || "";
  const abstract = get("abstract").trim();
  if (!abstract) return setStatus(status, "Add an abstract before asking for tag suggestions.", true);
  button.disabled = true;
  try {
    setStatus(status, "Suggesting tags…");
    const body = await request("/api/tags/suggestions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: get("title"), abstract, categories: get("categories").split(",").map((value) => value.trim()).filter(Boolean) }) });
    renderHostedTagSuggestions(form, body.suggestions || [], body.provider || "AI", body.model || "");
    setStatus(status, body.suggestions?.length ? "Review the suggested tags below." : "No specific tags were found.");
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    button.disabled = false;
  }
}));

document.querySelectorAll("[data-apply-tag-suggestions]").forEach((button) => button.addEventListener("click", () => {
  const form = button.closest("[data-paper-form]");
  const panel = button.closest("[data-tag-suggestions]");
  if (!form || !panel) return;
  const tags = String(form.elements.namedItem("tags")?.value || "").split(",").map((value) => value.trim()).filter(Boolean);
  const selected = [...panel.querySelectorAll("[data-tag-suggestion]:checked")].map((input) => input.dataset.tagName || "");
  const names = [...tags, ...selected].filter((name, index, values) => values.findIndex((value) => value.toLowerCase() === name.toLowerCase()) === index);
  form.elements.namedItem("tags").value = names.join(", ");
  panel.hidden = true;
  void saveHostedPaperForm(form, { statusMessage: `${selected.length} suggested tag${selected.length === 1 ? "" : "s"} added and saved.` });
}));

document.querySelectorAll("[data-source-url-go]").forEach((link) => {
  const form = link.closest("form");
  const input = form?.elements.namedItem("sourceUrl");
  const update = () => {
    const value = String(input?.value || "").trim();
    link.hidden = !/^https?:\/\//i.test(value);
    link.href = link.hidden ? "#" : value;
  };
  input?.addEventListener("input", update);
  update();
});

document.querySelectorAll("[data-copy-bibtex]").forEach((button) => button.addEventListener("click", async () => {
  const field = button.closest(".bibtex-section")?.querySelector("[data-bibtex]");
  if (!field) return;
  const text = field.value || field.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    field.focus();
    field.select();
    document.execCommand("copy");
  }
  button.textContent = "Copied";
  window.setTimeout(() => { button.textContent = "Copy"; }, 1500);
}));

document.querySelectorAll("[data-copy-citation]").forEach((button) => button.addEventListener("click", async () => {
  const text = button.dataset.copyCitation || button.closest(".citation-style")?.querySelector(".citation-text")?.textContent || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    document.body.appendChild(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }
  button.textContent = "Copied";
  window.setTimeout(() => { button.textContent = "Copy"; }, 1500);
}));

document.querySelectorAll("[data-collapse-section]").forEach((button) => button.addEventListener("click", (event) => {
  event.stopPropagation();
  const section = button.closest("details");
  if (!section) return;
  section.open = false;
  section.querySelector("summary")?.focus();
}));

document.querySelector("[data-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Uploading PDF…");
  try {
    const body = await request("/api/uploads", { method: "POST", body: new FormData(form) });
    const file = form.querySelector("input[type=file]").files[0];
    renderHostedPreview({ paper: { title: file.name.replace(/\.pdf$/i, "").replace(/[._]+/g, " ").trim() }, pdf: body.pdf });
    await saveHostedPaperForm(document.querySelector("#paper-form-new"), { redirect: "edit", statusMessage: "PDF saved. Add its metadata below." });
    setStatus(form, "PDF saved. Add its metadata below.");
  } catch (error) {
    setStatus(form, error.message, true);
  }
});

const singlePdfInput = document.querySelector("[data-single-pdf-input]");
singlePdfInput?.addEventListener("change", () => {
  if (singlePdfInput.files.length && singlePdfInput.form) singlePdfInput.form.requestSubmit();
});

const folderPdfInput = document.querySelector("[data-folder-pdf-input]");
const folderZipInput = document.querySelector("[data-folder-zip-input]");
folderPdfInput?.addEventListener("change", () => {
  if (folderPdfInput.files.length && folderPdfInput.form) {
    folderPdfInput.form.dataset.bulkSource = "folder";
    if (folderZipInput) folderZipInput.value = "";
    folderPdfInput.form.requestSubmit();
  }
});

folderZipInput?.addEventListener("change", () => {
  if (folderZipInput.files.length && folderZipInput.form) {
    folderZipInput.form.dataset.bulkSource = "zip";
    if (folderPdfInput) folderPdfInput.value = "";
    folderZipInput.form.requestSubmit();
  }
});

document.querySelector("[data-folder-tag-toggle]")?.addEventListener("change", (event) => {
  const toggle = event.currentTarget;
  const valueLabel = toggle.closest("[data-bulk-upload-form]")?.querySelector("[data-folder-tag-value]");
  if (valueLabel) valueLabel.textContent = String(toggle.checked);
});

document.querySelector("[data-bulk-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const source = form.dataset.bulkSource || (form.querySelector("[data-folder-zip-input]")?.files.length ? "zip" : "folder");
  const pdfFiles = source === "folder" ? [...(form.querySelector("[data-folder-pdf-input]")?.files || [])] : [];
  const zipFiles = source === "zip" ? [...(form.querySelector("[data-folder-zip-input]")?.files || [])] : [];
  if (!pdfFiles.length && !zipFiles.length) return setStatus(form, "Choose a folder or ZIP archive containing PDF files.", true);
  const importLabel = source === "zip" ? "PDFs from ZIP" : `${pdfFiles.length} PDF${pdfFiles.length === 1 ? "" : "s"} from folder`;
  const isZip = source === "zip";
  const files = source === "folder" ? pdfFiles : zipFiles;
  const progress = form.querySelector("[data-bulk-progress]");
  setStatus(form, isZip ? "Uploading and extracting ZIP archive…" : `Importing 0 of ${pdfFiles.length} PDFs… ETA calculating…`);
  progress?.classList.remove("is-indeterminate");
  updateOperationProgress(progress, 0, files.length);
  try {
    const relativePath = pdfFiles[0]?.webkitRelativePath || "";
    const folderTag = relativePath.split("/").filter(Boolean)[0] || "";
    const archiveTag = zipFiles[0]?.name.replace(/\.zip$/i, "") || "";
    const imported = [], skipped = [], failed = [];
    const appliedFolderTags = new Set();
    const startedAt = performance.now();
    const formatEta = (milliseconds) => { const seconds = Math.max(1, Math.ceil(milliseconds / 1000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); const remaining = seconds % 60; return `${minutes}m${remaining ? ` ${remaining}s` : ""}`; };
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const formData = new FormData();
      const filePath = file.webkitRelativePath || file.name;
      const pathParts = filePath.split(/[\\/]/).filter(Boolean);
      const immediateFolder = source === "folder" && pathParts.length > 1 ? pathParts[pathParts.length - 2] : "";
      formData.append("files", file, filePath);
      formData.set("folderTag", immediateFolder || folderTag || archiveTag);
      formData.set("useFolderAsTag", String(form.querySelector("[data-folder-tag-toggle]")?.checked ?? true));
      try {
        const body = isZip
          ? await requestWithUploadProgress("/api/bulk-upload", { method: "POST", body: formData }, {
            onProgress: (loaded, total) => {
              const percent = Math.round((loaded / total) * 100);
              setStatus(form, `Uploading ZIP archive… ${percent}%`);
              updateOperationProgress(progress, percent, 100);
            },
            onUploadComplete: () => {
              setStatus(form, "Upload complete. Extracting ZIP archive…");
              progress?.classList.add("is-indeterminate");
            },
          })
          : await request("/api/bulk-upload", { method: "POST", body: formData });
        imported.push(...body.imported); skipped.push(...body.skipped); failed.push(...body.failed);
        (body.folderTags || (body.folderTag ? [body.folderTag] : [])).forEach((tag) => appliedFolderTags.add(tag));
        if (isZip) setStatus(form, `Loaded ${body.discovered ?? imported.length} PDFs from ZIP; preparing metadata…`);
      } catch (error) {
        failed.push({ filename: file.name, reason: error.message });
      }
      const finished = index + 1;
      if (!isZip) {
        const remaining = files.length - finished;
        const average = (performance.now() - startedAt) / finished;
        const eta = remaining ? ` ETA ~${formatEta(average * remaining)} remaining` : "";
        setStatus(form, `Importing ${finished} of ${files.length} PDFs…${eta}`);
      }
      updateOperationProgress(progress, finished, files.length);
    }
    progress?.classList.remove("is-indeterminate");
    updateOperationProgress(progress, files.length, files.length);
    const importedPapers = imported.map((item) => ({ id: item.id, title: item.title, authors: [], tags: item.tags || [] }));
    const metadata = imported.length
      ? await runHostedMetadataBatch(importedPapers, { statusElement: form.querySelector(".form-status"), progress })
      : { succeeded: 0, failed: 0 };
    const tagSummary = [...appliedFolderTags].join("\", \"");
    setStatus(form, `Imported ${imported.length}; metadata found for ${metadata.succeeded}; skipped ${skipped.length}; failed ${failed.length + metadata.failed}${tagSummary ? `; tagged as “${tagSummary}”` : ""}.`);
    const results = form.querySelector("[data-bulk-results]");
    if (results) results.innerHTML = [...imported.map((item) => `<div class="result-success">Imported: ${escapeHtml(item.title)}</div>`), ...skipped.map((item) => `<div class="result-muted">Skipped: ${escapeHtml(item.filename)} (${escapeHtml(item.reason)})</div>`), ...failed.map((item) => `<div class="result-error">Failed: ${escapeHtml(item.filename)} (${escapeHtml(item.reason)})</div>`)].join("");
  } catch (error) {
    setStatus(form, error.message, true);
  }
});

async function initSettings() {
  const form = document.querySelector("#settings-form");
  if (!form) return;
  const status = document.querySelector("#settings-status");
  try {
    const settings = await request("/api/settings/llm");
    form.elements.provider.value = settings.provider; form.elements.openaiModel.value = settings.openaiModel; form.elements.openaiEmbeddingModel.value = settings.openaiEmbeddingModel;
    setStatus(document.querySelector("#key-status"), settings.openaiConfigured ? "OpenAI Worker Secret is configured." : "OpenAI Worker Secret is not configured.");
  } catch (error) { setStatus(status, error.message, true); }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const settings = await request("/api/settings/llm", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: form.elements.provider.value, openaiModel: form.elements.openaiModel.value, openaiEmbeddingModel: form.elements.openaiEmbeddingModel.value }) });
      setStatus(status, "Settings saved."); setStatus(document.querySelector("#key-status"), settings.openaiConfigured ? "OpenAI Worker Secret is configured." : "OpenAI Worker Secret is not configured.");
    } catch (error) { setStatus(status, error.message, true); }
  });
  const backupCreate = document.querySelector("#backup-create");
  const backupDownload = document.querySelector("#backup-download");
  const backupId = document.querySelector("#backup-id");
  const backupMode = document.querySelector("#backup-mode");
  const backupRestore = document.querySelector("#backup-restore");
  const backupStatus = document.querySelector("#backup-status");
  const backupInitialize = document.querySelector("#backup-initialize");
  const backupRefresh = document.querySelector("#backup-refresh");
  const backupList = document.querySelector("#backup-list");
  const backupListStatus = document.querySelector("#backup-list-status");
  const backupKindLabels = { daily: "Daily backups", monthly: "Monthly backups", manual: "Manual backups" };
  const formatBackupDate = (value) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  const renderBackups = (backups) => {
    if (!backupList) return;
    const groups = ["daily", "monthly", "manual"].map((kind) => ({ kind, items: backups.filter((backup) => backup.kind === kind) })).filter((group) => group.items.length);
    backupList.innerHTML = groups.length ? groups.map((group) => `<section class="backup-kind"><div class="backup-kind-heading"><h4>${backupKindLabels[group.kind]}</h4><span class="muted">${group.items.length} available</span></div><div class="backup-entry-list">${group.items.map((backup) => `<article class="backup-entry"><div class="backup-entry-info"><strong>${escapeHtml(formatBackupDate(backup.createdAt))}</strong><span class="muted">${backup.papers} paper${backup.papers === 1 ? "" : "s"} · ${backup.pdfs} PDF${backup.pdfs === 1 ? "" : "s"} · expires ${escapeHtml(new Date(backup.expiresAt).toLocaleDateString())}</span></div><div class="backup-entry-actions"><a class="button button-secondary button-small" href="${escapeHtml(backup.manifestUrl)}">Download</a><button class="button button-secondary button-small" type="button" data-backup-select="${escapeHtml(backup.backupId)}">Use for restore</button></div></article>`).join("")}</div></section>`).join("") : `<p class="muted backup-empty">No active backups found yet.</p>`;
  };
  const loadBackups = async () => {
    if (!backupList) return;
    try {
      setStatus(backupListStatus, "Loading backups…");
      const result = await request("/api/backups");
      const backups = result.backups || [];
      renderBackups(backups);
      if (backupInitialize) backupInitialize.hidden = backups.some((backup) => backup.kind === "daily") && backups.some((backup) => backup.kind === "monthly");
      setStatus(backupListStatus, "");
    } catch (error) { setStatus(backupListStatus, error.message, true); }
  };
  backupRefresh?.addEventListener("click", loadBackups);
  backupInitialize?.addEventListener("click", async () => {
    backupInitialize.disabled = true;
    try {
      setStatus(backupStatus, "Creating the initial daily and monthly backups…");
      const result = await request("/api/backups/initialize", { method: "POST" });
      setStatus(backupStatus, `Initial daily and monthly backups ready: ${result.daily.papers} paper${result.daily.papers === 1 ? "" : "s"}, ${result.daily.pdfs} PDF${result.daily.pdfs === 1 ? "" : "s"}.`);
      await loadBackups();
    } catch (error) { setStatus(backupStatus, error.message, true); }
    finally { backupInitialize.disabled = false; }
  });
  backupList?.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-backup-select]") : null;
    if (!target) return;
    backupId.value = target.dataset.backupSelect || "";
    setStatus(backupStatus, "Backup selected for restore.");
    document.querySelector("#backup-id")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
  backupCreate?.addEventListener("click", async () => {
    backupCreate.disabled = true;
    try {
      setStatus(backupStatus, "Creating backup and copying PDFs to R2…");
      const result = await request("/api/backups", { method: "POST" });
      backupId.value = result.backupId;
      backupDownload.href = result.manifestUrl;
      backupDownload.hidden = false;
      setStatus(backupStatus, `Backup ready: ${result.papers} paper${result.papers === 1 ? "" : "s"}, ${result.pdfs} PDF${result.pdfs === 1 ? "" : "s"}. Expires ${new Date(result.expiresAt).toLocaleDateString()}.`);
      await loadBackups();
    } catch (error) { setStatus(backupStatus, error.message, true); }
    finally { backupCreate.disabled = false; }
  });
  backupRestore?.addEventListener("click", async () => {
    const value = backupId.value.trim();
    if (!value) return setStatus(backupStatus, "Enter a backup ID first.", true);
    const restoreMode = backupMode?.value || "merge";
    if (restoreMode === "replace" && !confirm("Replace the current hosted library? A safety backup will be created first, but unrelated current papers will be removed after all target batches succeed.")) return;
    backupRestore.disabled = true;
    try {
      let offset = 0;
      let total = 0;
      let restoredPapers = 0;
      let restoredPdfs = 0;
      let safetyBackupId = "";
      let complete = false;
      while (!complete) {
        setStatus(backupStatus, total ? `${restoreMode === "replace" ? "Replacing" : "Restoring"} ${offset} of ${total} papers…` : `${restoreMode === "replace" ? "Replacing" : "Restoring"} backup…`);
        const result = await request(`/api/backups/${encodeURIComponent(value)}/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: restoreMode, offset, limit: 25, safetyBackupId: safetyBackupId || undefined }) });
        if (result.nextOffset <= offset && !result.complete) throw new Error("Restore made no progress. Retry with the backup ID.");
        restoredPapers += result.restoredPapers; restoredPdfs += result.restoredPdfs; total = result.totalPapers; offset = result.nextOffset; safetyBackupId = result.safetyBackupId || safetyBackupId; complete = result.complete;
      }
      setStatus(backupStatus, restoreMode === "replace" ? `Replaced ${restoredPapers} paper${restoredPapers === 1 ? "" : "s"} and ${restoredPdfs} PDF${restoredPdfs === 1 ? "" : "s"}. Safety backup: ${safetyBackupId}.` : `Restored ${restoredPapers} paper${restoredPapers === 1 ? "" : "s"} and ${restoredPdfs} PDF${restoredPdfs === 1 ? "" : "s"}.`);
    } catch (error) { setStatus(backupStatus, error.message, true); }
    finally { backupRestore.disabled = false; }
  });
  await loadBackups();
}

async function initAsk() {
  const form = document.querySelector("#ask-form");
  if (!form) return;
  const query = document.querySelector("#ask-query");
  const status = document.querySelector("#ask-status");
  const coverageElement = document.querySelector("#ask-coverage");
  const results = document.querySelector("#ask-results");
  const indexButton = document.querySelector("#ask-index");
  const indexStatus = document.querySelector("#ask-index-status");
  let tagMode = "or";
  const selectedTags = () => [...form.querySelectorAll("[data-ask-tag][aria-pressed=true]")].map((button) => button.dataset.askTag).filter(Boolean);
  form.querySelectorAll("[data-ask-tag-mode]").forEach((button) => button.addEventListener("click", () => { tagMode = button.dataset.askTagMode === "and" ? "and" : "or"; form.querySelectorAll("[data-ask-tag-mode]").forEach((item) => { item.setAttribute("aria-pressed", String(item === button)); item.classList.toggle("tag-selected", item === button); }); }));
  form.querySelector("[data-ask-tag-all]")?.addEventListener("click", (event) => { const button = event.currentTarget; form.querySelectorAll("[data-ask-tag]").forEach((item) => { item.setAttribute("aria-pressed", "false"); item.classList.remove("tag-selected"); }); button.setAttribute("aria-pressed", "true"); button.classList.add("tag-selected"); });
  form.querySelectorAll("[data-ask-tag]").forEach((button) => button.addEventListener("click", () => { const all = form.querySelector("[data-ask-tag-all]"); const selected = button.getAttribute("aria-pressed") === "true"; button.setAttribute("aria-pressed", String(!selected)); button.classList.toggle("tag-selected", !selected); if (all) { all.setAttribute("aria-pressed", "false"); all.classList.remove("tag-selected"); } }));
  const showCoverage = (coverage) => setStatus(coverageElement, `${coverage.indexedPapers} indexed · ${coverage.pendingPapers} pending · ${coverage.totalPapers} total`);
  const loadCoverage = async () => {
    try { showCoverage((await request("/api/search/coverage")).coverage); }
    catch (error) { setStatus(coverageElement, error.message, true); }
  };
  const renderResults = (body) => {
    const warnings = (body.warnings || []).map((warning) => `<p class="hosted-search-warning">${escapeHtml(warning)}</p>`).join("");
    const hits = body.hits || [];
    const groups = body.groups || [];
    const referenceNumbers = new Map(hits.map((hit, index) => [hit.paper.id, index + 1]));
    const groupHtml = groups.length ? `<section><div class="ask-results-heading"><h2>Themes</h2></div><div class="ask-group-list">${groups.map((group) => { const paperIds = [...new Set(group.paperIds || [])]; return `<article class="ask-group"><div class="ask-group-header"><div><h3>${escapeHtml(group.name)}</h3><p>${escapeHtml(group.description)}</p></div><a class="button button-secondary button-small ask-group-select" href="${hostedLibrarySelectionUrl(paperIds)}">Select ${paperIds.length} paper${paperIds.length === 1 ? "" : "s"}</a></div>${group.evidence ? `<p class="muted ask-group-evidence">${escapeHtml(group.evidence)}</p>` : ""}<div class="ask-paper-list">${paperIds.map((id, index) => { const hit = hits.find((item) => item.paper.id === id); const reference = referenceNumbers.get(id); return hit ? `${index ? `<hr class="ask-paper-divider">` : ""}<div class="ask-paper-row"><h4>${reference ? `<span class="ask-paper-reference">[${reference}]</span>` : ""}<a href="/papers/${encodeURIComponent(hit.paper.id)}">${escapeHtml(hit.paper.title)}</a></h4><p class="muted ask-paper-meta">${escapeHtml((hit.paper.authors || []).slice(0, 3).join(", "))}${hit.paper.year ? ` · ${escapeHtml(hit.paper.year)}` : ""}</p></div>` : ""; }).join("")}</div></article>`; }).join("")}</div></section>` : "";
    const hitHtml = hits.length ? `<section><div class="ask-results-heading"><div><h2>Relevant papers</h2><span class="muted">Ranked by semantic and keyword match</span></div><button class="button button-secondary button-small ask-select-results" type="button" data-hosted-select-results disabled>Select selected papers</button></div><div class="ask-result-list">${hits.map((hit) => `<article class="ask-result"><div class="ask-result-select-row"><input class="ask-result-checkbox" type="checkbox" value="${escapeHtml(hit.paper.id)}" aria-label="Select ${escapeHtml(hit.paper.title)}"><div class="ask-result-content"><h3><a href="/papers/${encodeURIComponent(hit.paper.id)}">${escapeHtml(hit.paper.title)}</a></h3><p class="muted ask-result-meta">${escapeHtml((hit.paper.authors || []).slice(0, 3).join(", ") || "No authors recorded")}${hit.paper.year ? ` · ${escapeHtml(hit.paper.year)}` : ""} · ${escapeHtml(hit.matchType)} · ${(Number(hit.score) * 100).toFixed(0)}% match</p>${hit.evidence || hit.paper.abstract ? `<p class="ask-evidence-label">Relevant passage</p><p class="ask-evidence">${escapeHtml(hit.evidence || hit.paper.abstract)}</p>` : ""}</div></div></article>`).join("")}</div></section>` : `<div class="empty-state"><h2>No matching papers</h2><p class="muted">Try a broader idea or remove one of the tag filters.</p></div>`;
    results.innerHTML = `${warnings}<div class="ask-results-heading"><div><p class="eyebrow">Library query</p><p class="muted">${body.hits?.length || 0} result${body.hits?.length === 1 ? "" : "s"}.</p></div></div>${groupHtml}${hitHtml}`;
    const button = results.querySelector("[data-hosted-select-results]");
    const checkboxes = [...results.querySelectorAll(".ask-result-checkbox")];
    const updateSelection = () => { const selected = checkboxes.filter((checkbox) => checkbox.checked); if (button) { button.disabled = selected.length === 0; button.textContent = selected.length ? `Select ${selected.length} paper${selected.length === 1 ? "" : "s"}` : "Select selected papers"; } };
    checkboxes.forEach((checkbox) => checkbox.addEventListener("change", updateSelection));
    button?.addEventListener("click", () => { const selected = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value); if (selected.length) window.location.href = hostedLibrarySelectionUrl(selected); });
    updateSelection();
    results.hidden = false;
  };
  await loadCoverage();
  indexButton?.addEventListener("click", async () => {
    indexButton.disabled = true;
    try {
      setStatus(indexStatus, "Indexing pending papers…");
      const body = await request("/api/search/index", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }) });
      showCoverage(body.coverage); setStatus(indexStatus, body.coverage.pendingPapers ? "Some papers remain pending; run indexing again to continue." : "Library index is ready.");
    } catch (error) { setStatus(indexStatus, error.message, true); }
    finally { indexButton.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!query.value.trim()) return;
    try {
      setStatus(status, "Searching…");
      const body = await request("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: query.value.trim(), tags: selectedTags(), tagMode, limit: 20 }) });
      renderResults(body); showCoverage(body.coverage); setStatus(status, `${body.hits.length} result${body.hits.length === 1 ? "" : "s"}.`);
    } catch (error) { setStatus(status, error.message, true); }
  });
  form.querySelector("[data-ask-rephrase]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!query.value.trim()) { setStatus(status, "Enter a question or topic first.", true); return; }
    button.disabled = true;
    try {
      setStatus(status, "Rephrasing the query…");
      const body = await request("/api/search/rephrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: query.value.trim() }) });
      query.value = body.query || query.value;
      setStatus(status, "Query rephrased. Review it, then ask.");
    } catch (error) { setStatus(status, error.message, true); }
    finally { button.disabled = false; }
  });
}

async function runHostedQuestion(paperId, questionId) {
  await request(`/api/papers/${encodeURIComponent(paperId)}/questions/${encodeURIComponent(questionId)}`, { method: "POST" });
  return pollUntil(
    async () => (await request(`/api/papers/${encodeURIComponent(paperId)}/questions`)).questions.find((item) => item.id === questionId),
    (item) => item?.answer && ["complete", "error", "stale"].includes(item.answer.status),
    600000,
    1000,
  );
}

function updateHostedQuestionOverview(item) {
  const questionId = String(item?.id || "");
  const complete = item?.answer?.status === "complete";
  const question = [...document.querySelectorAll("[data-question-id]")].find((entry) => entry.dataset.questionId === questionId);
  const group = question?.closest("[data-question-group]");
  const questions = group ? [...group.querySelectorAll("[data-question-id]")] : [];
  const questionIndex = questions.indexOf(question);
  if (question && complete) question.dataset.answerComplete = "true";
  const answered = questions.filter((entry) => entry.dataset.answerComplete === "true" || entry.querySelector(".question-answer")).length;
  const progress = group?.querySelector(".question-progress");
  if (progress) {
    progress.setAttribute("aria-label", `${answered} of ${questions.length} questions answered`);
    progress.setAttribute("title", `${answered} of ${questions.length} questions answered`);
    const dot = progress.querySelectorAll(".question-progress-dot")[questionIndex];
    dot?.classList.toggle("is-answered", complete);
  }
  const overview = [...document.querySelectorAll("[data-question-overview-dot]")].find((dot) => dot.dataset.questionOverviewDot === questionId);
  overview?.classList.toggle("is-answered", complete);
  const overviewProgress = overview?.closest(".question-overview-progress");
  if (overviewProgress) {
    const dots = [...overviewProgress.querySelectorAll(".question-progress-dot")];
    const complete = dots.filter((dot) => dot.classList.contains("is-answered")).length;
    overviewProgress.setAttribute("aria-label", `${complete} of ${dots.length} questions answered`);
    overviewProgress.setAttribute("title", `${complete} of ${dots.length} questions answered`);
  }
}

async function generateHostedQuestion(button) {
  const detail = document.querySelector(".paper-detail-page");
  const paperId = detail?.dataset.paperId;
  const item = button.closest("[data-question-id]");
  if (!paperId || !item) return false;
  const status = item.querySelector("[data-question-status]");
  button.disabled = true;
  setStatus(status, "Generating…");
  try {
    const question = await runHostedQuestion(paperId, button.dataset.generateQuestion);
    item.querySelector(".question-empty, .status-error, .status-warning")?.remove();
    item.querySelector(".question-answer, .question-answer-meta")?.remove();
    if (question?.answer?.status !== "complete") throw new Error(question?.answer?.errorMessage || "Question generation failed.");
    const answer = document.createElement("div");
    answer.className = "analysis-content question-answer";
    answer.innerHTML = renderHostedMarkdown(question.answer.content);
    item.querySelector(".question-actions")?.before(answer);
    const meta = document.createElement("p");
    meta.className = "analysis-meta question-answer-meta muted";
    meta.textContent = `${question.answer.provider} · ${question.answer.model} · ${new Date(question.answer.generatedAt).toLocaleString("en-GB")}${typeof question.answer.durationMs === "number" ? ` · ${Math.floor(question.answer.durationMs / 60000)}:${String(Math.floor(question.answer.durationMs / 1000) % 60).padStart(2, "0")}` : ""}`;
    item.querySelector(".question-actions")?.before(meta);
    typesetHostedMath([answer]);
    setStatus(status, "Saved.");
    updateHostedQuestionOverview(question);
    const label = button.querySelector("span:last-child");
    if (label) label.textContent = "Regenerate answer";
    return true;
  } catch (error) {
    item.querySelector(".question-empty")?.remove();
    setStatus(status, error.message, true);
    return false;
  } finally {
    button.disabled = false;
  }
}

function initHostedQuestions() {
  const section = document.querySelector("[data-questions-section]");
  const detail = document.querySelector(".paper-detail-page");
  if (!section || !detail) return;
  section.querySelectorAll("[data-generate-question]").forEach((button) => button.addEventListener("click", () => generateHostedQuestion(button)));
  section.querySelector("[data-toggle-questions]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const groups = [...section.querySelectorAll("[data-question-group]")];
    const expand = groups.some((group) => !group.open);
    groups.forEach((group) => { group.open = expand; });
    const button = event.currentTarget;
    button.setAttribute("aria-label", expand ? "Collapse all questions" : "Expand all questions");
    button.setAttribute("title", expand ? "Collapse all questions" : "Expand all questions");
    const icon = button.querySelector(".material-symbols-outlined");
    if (icon) icon.textContent = expand ? "unfold_less" : "unfold_more";
  });
  section.querySelector("[data-generate-all-questions]")?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const button = event.currentTarget;
    const status = section.querySelector("[data-questions-status]");
    const buttons = [...section.querySelectorAll("[data-generate-question]")];
    const pending = buttons.filter((questionButton) => !questionButton.closest("[data-question-id]")?.querySelector(".question-answer"));
    const skipped = buttons.length - pending.length;
    if (!pending.length) {
      setStatus(status, "All answers have already been generated.");
      button.disabled = false;
      return;
    }
    const progress = createOperationProgress(status);
    const formatRemainingTime = (milliseconds) => {
      const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ""}`;
    };
    button.disabled = true;
    let completed = 0;
    let failed = 0;
    const durations = [];
    const updateProgress = () => {
      const finished = completed + failed;
      const remaining = pending.length - finished;
      const averageDuration = durations.length ? durations.reduce((total, duration) => total + duration, 0) / durations.length : 0;
      const estimate = averageDuration && remaining ? ` ETA ~${formatRemainingTime(averageDuration)} remaining` : "";
      setStatus(status, `Generating answer ${Math.min(finished + 1, pending.length)} of ${pending.length}…${estimate}`);
      updateOperationProgress(progress, finished, pending.length);
    };
    updateProgress();
    await Promise.all(pending.map(async (questionButton) => {
      const startedAt = performance.now();
      if (await generateHostedQuestion(questionButton)) completed += 1; else failed += 1;
      durations.push(performance.now() - startedAt);
      updateProgress();
    }));
    setStatus(status, `Saved ${completed} answer${completed === 1 ? "" : "s"}${skipped ? `; skipped ${skipped} already generated` : ""}${failed ? `; ${failed} failed. Retry failed questions.` : "."}`, failed > 0);
    button.disabled = false;
  });
  section.querySelector("[data-add-question]")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const question = form.elements.namedItem("question")?.value?.trim() || "";
    if (!question) return;
    setStatus(form, "Adding question…");
    try {
      await request(`/api/papers/${encodeURIComponent(detail.dataset.paperId)}/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
      window.location.reload();
    } catch (error) { setStatus(form, error.message, true); }
  });
}

async function initPaper() {
  const detail = document.querySelector(".paper-detail-page");
  if (!detail) return;
  const id = detail.dataset.paperId;
  const editForm = document.querySelector("#paper-edit-form");
  const paperStatus = document.querySelector("#paper-status");
  const analysisStatus = document.querySelector("#analysis-status");
  const summary = document.querySelector("#paper-summary");
  const answer = document.querySelector("#paper-question-answer");
  try {
    const paper = (await request(`/api/papers/${encodeURIComponent(id)}`)).paper;
    if (editForm) {
      editForm.elements.title.value = paper.title; editForm.elements.authors.value = (paper.authors || []).join("\n"); editForm.elements.tags.value = (paper.tags || []).join(", "); editForm.elements.abstract.value = paper.abstract || "";
    }
    const abstractSection = document.querySelector("#paper-abstract-section");
    const abstract = document.querySelector("#paper-abstract");
    if (abstract && paper.abstract) { abstract.textContent = paper.abstract; abstractSection.hidden = false; void typesetHostedMath([abstract]); }
    const tagsSection = document.querySelector("#paper-tags-section");
    const tags = document.querySelector("#paper-tags");
    if (tags && paper.tags?.length) { tags.innerHTML = paper.tags.map((tag) => `<span class="tag">${escapeHtml(displayTagName(tag))}</span>`).join(" "); if (tagsSection) tagsSection.hidden = false; }
    const existing = await request(`/api/papers/${encodeURIComponent(id)}/summary`);
    if (existing.summary?.status === "complete") {
      summary.innerHTML = `<div class="analysis-content">${renderHostedMarkdown(existing.summary.content)}</div>${renderHostedAnalysisMeta(existing.summary)}`;
      markHostedSummaryComplete();
      typesetHostedMath([summary]);
    }
  } catch (error) { setStatus(paperStatus, error.message, true); }
  editForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(editForm);
      const updated = await request(`/api/papers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: data.get("title"), authors: String(data.get("authors") || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean), tags: String(data.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean), abstract: data.get("abstract"), metadataSource: "manual" }) });
      document.querySelector("#paper-title").textContent = updated.paper.title; setStatus(paperStatus, "Metadata saved.");
    } catch (error) { setStatus(paperStatus, error.message, true); }
  });
  document.querySelectorAll("[data-summary-mode]").forEach((button) => button.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await runSummary(id, async (heading, content, record) => { const queued = content === "Queued…"; summary.innerHTML = `<div class="analysis-content${queued ? " analysis-queued" : ""}">${renderHostedMarkdown(content)}</div>${renderHostedAnalysisMeta(record)}`; markHostedSummaryComplete(); setStatus(analysisStatus, "Rendering summary…"); await new Promise((resolve) => window.requestAnimationFrame(resolve)); await typesetHostedMath([summary]); setStatus(analysisStatus, `${heading} ready.`); }, button.dataset.summaryMode || "quick"); }
    catch (error) { setStatus(analysisStatus, error.message, true); }
    finally { event.currentTarget.disabled = false; }
  }));
  document.querySelector("#paper-question-button")?.addEventListener("click", async (event) => {
    const input = document.querySelector("#paper-question-input");
    const question = input?.value || window.prompt("What would you like to ask about this paper?");
    if (!question?.trim()) return;
    event.currentTarget.disabled = true;
    try { await runQuestion(id, question, (heading, content) => { showAnalysisResult(answer, heading, content); setStatus(analysisStatus, `${heading} ready.`); }); }
    catch (error) { showAnalysisResult(answer, "Answer unavailable", error.message, true); setStatus(analysisStatus, error.message, true); }
    finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#paper-delete")?.addEventListener("click", async () => {
    if (!confirm("Delete this paper and its PDF?")) return;
    try { await request(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" }); window.location.href = "/"; }
    catch (error) { setStatus(paperStatus, error.message, true); }
  });
}

function initEdit() {
  const form = document.querySelector("[data-paper-form][data-mode='edit']");
  if (!form) return;
  const id = form.dataset.paperId;
  const replace = document.querySelector("[data-replace-upload]");
  replace?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = replace.elements.file.files?.[0];
    if (!file) return;
    try {
      setStatus(document.querySelector("#replace-status"), "Uploading replacement PDF…");
      const upload = await request("/api/uploads", { method: "POST", body: new FormData(replace) });
      await request(`/api/papers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...hostedPaperBody(form), id, stagingToken: upload.pdf.stagingToken }) });
      window.location.href = `/papers/${encodeURIComponent(id)}`;
    } catch (error) { setStatus(document.querySelector("#replace-status"), error.message, true); }
  });
}

async function initImport() {
  const form = document.querySelector("#import-form");
  if (!form) return;
  const status = document.querySelector("#import-status");
  const preview = document.querySelector("#import-preview");
  const pdfStatus = document.querySelector("#import-pdf-status");
  const button = form.querySelector("button[type=submit]");
  let staged;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setLookupBusy(button, true);
    try {
      setStatus(status, "Looking up arXiv metadata and PDF…");
      const resolved = await resolveHostedFindInput(form.elements.input.value, status);
      staged = await requestWithLookupProgress("/api/import?progress=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: resolved.input }),
      }, (progress) => updateLookupProgress(button, progress, form));
      renderHostedPreview(staged);
      const previewForm = document.querySelector("#paper-form-new");
      if (resolved.bibtex) setValue(previewForm, "bibtex", resolved.bibtex);
      setStatus(pdfStatus, staged.pdf?.status === "staged" ? "PDF staged" : "Metadata only");
      const saved = await saveHostedPaperForm(previewForm, { redirect: "edit", statusMessage: staged.warnings?.length ? staged.warnings.join(" ") : "Metadata found and saved." });
      const pdfMessage = staged.pdf?.status === "staged" ? "Metadata found and PDF saved." : "Metadata found and saved.";
      setStatus(status, saved ? (staged.warnings?.length ? `${pdfMessage} ${staged.warnings.join(" ")}` : pdfMessage) : "Metadata found. Fix the error below and retry.", !saved);
    } catch (error) {
      staged = undefined;
      preview.hidden = true;
      setStatus(status, error.message, true);
    } finally {
      clearLookupProgress(button);
      setLookupBusy(button, false);
    }
  });
}

initLibrary();
initSettings();
initAsk();
initPaper();
initHostedQuestions();
initEdit();
initImport();
