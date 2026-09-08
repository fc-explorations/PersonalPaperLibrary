const page = document.body.dataset.hostedPage || "library";

const themeStorageKey = "personal-paper-library-theme";
const accentThemes = { forest: ["#315c52", "#264b43", "#eaf0ed", "#aabbb4"], blue: ["#3d5a80", "#2d4665", "#e8eef5", "#aab9cb"], terracotta: ["#9a4e36", "#7d3d2b", "#f5e9e4", "#d8b6aa"], plum: ["#6b4c73", "#553b5c", "#eee8f0", "#c4b5c8"], slate: ["#58606a", "#434a52", "#edf0f2", "#b7bec4"] };
const backgroundThemes = { paper: "#f7f6f2", white: "#ffffff", "light-gray": "#eeeeec", warm: "#f3efe8", mint: "#f6fdfa" };
const pageSizes = [10, 25, 50, 100];
function loadTheme() { try { return JSON.parse(localStorage.getItem(themeStorageKey) || "{}"); } catch { return {}; } }
function applyTheme(theme) {
  const accent = theme.accent === "custom" ? (theme.customAccent || "#315c52") : (accentThemes[theme.accent] || accentThemes.forest)[0];
  const accentSet = theme.accent === "custom" ? [accent, `color-mix(in srgb, ${accent} 82%, black 18%)`, `color-mix(in srgb, ${accent} 12%, white 88%)`, `color-mix(in srgb, ${accent} 48%, white 52%)`] : (accentThemes[theme.accent] || accentThemes.forest);
  const background = theme.background === "custom" ? (theme.customBackground || "#f7f6f2") : (backgroundThemes[theme.background] || backgroundThemes.paper);
  document.documentElement.style.setProperty("--accent", accentSet[0]); document.documentElement.style.setProperty("--accent-dark", accentSet[1]); document.documentElement.style.setProperty("--accent-soft", accentSet[2]); document.documentElement.style.setProperty("--accent-border", accentSet[3]); document.documentElement.style.setProperty("--page-bg", background); document.documentElement.style.setProperty("--content-width", `${[50, 60, 70, 80, 90, 100].includes(Number(theme.contentWidth)) ? theme.contentWidth : 90}%`);
  document.querySelectorAll("[data-theme-setting]").forEach((input) => { const key = input.dataset.themeSetting; const selected = key === "accent" ? (accentThemes[input.value] ? (theme.accent || "forest") : theme.accent) : key === "background" ? (backgroundThemes[input.value] ? (theme.background || "paper") : theme.background) : key === "contentWidth" ? String(theme.contentWidth || 90) : String(theme.pageSize || 50); input.checked = input.value === selected; });
  document.querySelectorAll("[data-theme-picker]").forEach((input) => { input.value = input.dataset.themePicker === "accent" ? theme.customAccent || "#315c52" : theme.customBackground || "#f7f6f2"; });
}
let selectedTheme = loadTheme();
applyTheme(selectedTheme);
document.querySelectorAll("[data-theme-setting]").forEach((input) => input.addEventListener("change", () => { selectedTheme = { ...selectedTheme, [input.dataset.themeSetting]: input.value }; localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme)); applyTheme(selectedTheme); }));
document.querySelectorAll("[data-theme-picker]").forEach((input) => input.addEventListener("input", () => { const group = input.dataset.themePicker; selectedTheme = { ...selectedTheme, [group]: "custom", [group === "accent" ? "customAccent" : "customBackground"]: input.value }; localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme)); applyTheme(selectedTheme); }));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character]));
}

async function request(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body;
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

async function pollUntil(load, done, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await load();
    if (done(value)) return value;
    await sleep(3000);
  }
  throw new Error("The analysis job is taking longer than expected. Refresh to check its status.");
}

function showAnalysisResult(element, heading, content, error = false) {
  if (!element) return;
  element.className = `analysis-result${error ? " status-error" : ""}`;
  element.innerHTML = `<strong>${escapeHtml(heading)}</strong><pre>${escapeHtml(content)}</pre>`;
  element.hidden = false;
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
  onUpdate("Summary", summary.summary?.content || "The summary completed without content.");
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
  return { q: params.get("q") || "", sort: params.get("sort") || "newest", tags: params.getAll("tag"), tagMode: params.get("tagMode") === "and" ? "and" : "or", untagged: params.get("untagged") === "1", page: Math.max(1, Number(params.get("page") || 1) || 1), pageSize: pageSizes.includes(Number(selectedTheme.pageSize)) ? Number(selectedTheme.pageSize) : 50 };
}

function libraryUrl(state, changes = {}) {
  const next = { ...state, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set("q", next.q);
  if (next.sort && next.sort !== "newest") params.set("sort", next.sort);
  (next.tags || []).forEach((tag) => params.append("tag", tag));
  if (next.tagMode && next.tagMode !== "or") params.set("tagMode", next.tagMode);
  if (next.untagged) params.set("untagged", "1");
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function paperCard(paper) {
  const tags = (paper.tags || []).map((tag) => `<a class="tag" href="${libraryUrl(libraryState(), { tags: [tag], untagged: false, page: 1 })}">${escapeHtml(tag)}</a>`).join(" ");
  const authors = (paper.authors || []).join(", ");
  const venue = paper.acceptedVenue || paper.journalRef || "";
  const meta = [authors || "No authors recorded", venue, paper.year ? String(paper.year) : ""].filter(Boolean).join(" · ");
  return `<article class="paper-card">${paper.r2Key ? "" : `<span class="pdf-badge pdf-missing-badge" title="PDF missing" aria-label="PDF missing"><span class="material-symbols-outlined" aria-hidden="true">picture_as_pdf</span></span>`}<label class="paper-select"><input type="checkbox" data-select-paper="${escapeHtml(paper.id)}" aria-label="Select ${escapeHtml(paper.title)}"></label><div class="paper-card-main"><h2><a href="/papers/${encodeURIComponent(paper.id)}">${escapeHtml(paper.title)}</a></h2><p class="paper-meta muted">${escapeHtml(meta)}</p></div>${tags ? `<div class="paper-tags">${tags}</div>` : ""}</article>`;
}

function renderLibraryTags(tags, state) {
  const tagLinks = tags.map((tag) => {
    const selected = state.tags.some((value) => value.toLowerCase() === tag.toLowerCase());
    const nextTags = selected ? state.tags.filter((value) => value.toLowerCase() !== tag.toLowerCase()) : [...state.tags, tag];
    return `<a class="tag${selected ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: nextTags, untagged: false, page: 1 })}" aria-pressed="${selected}">${escapeHtml(tag)}</a>`;
  }).join(" ");
  const allSelected = !state.tags.length && !state.untagged;
  return `<span class="tag-mode-label">Match:</span> <a class="tag tag-mode-button${state.tagMode === "and" ? " tag-selected" : ""}" href="${libraryUrl(state, { tagMode: "and", page: 1 })}">AND</a> <a class="tag tag-mode-button${state.tagMode === "or" ? " tag-selected" : ""}" href="${libraryUrl(state, { tagMode: "or", page: 1 })}">OR</a> <span class="tag-mode-label">Tags:</span> <a class="tag${allSelected ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: [], untagged: false, page: 1 })}">ALL</a> <a class="tag${state.untagged ? " tag-selected" : ""}" href="${libraryUrl(state, { tags: [], untagged: !state.untagged, page: 1 })}">NONE</a> ${tagLinks}`;
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
    if (state.untagged) params.set("untagged", "1");
    const [body, tagBody] = await Promise.all([request(`/api/papers?${params}`), request("/api/tags")]);
    const pageCount = Math.max(1, Math.ceil(body.total / state.pageSize));
    if (body.total && state.page > pageCount) return window.location.replace(libraryUrl(state, { page: pageCount }));
    document.querySelector("#library-tags").innerHTML = renderLibraryTags(tagBody.tags || [], state);
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
  actions.hidden = selected === 0;
  actions.innerHTML = selected ? `<button class="button button-secondary" type="button" data-bulk-tags>Edit tags</button><button id="delete-selected" class="button button-danger" type="button">Delete selected (${selected})</button>` : "";
}

function initLibrary() {
  const list = document.querySelector("#paper-list");
  const form = document.querySelector("#library-search-form");
  if (!list || !form) return;
  list.addEventListener("change", (event) => { if (event.target.closest("[data-select-paper]")) updateBulkState(); });
  document.querySelector("#bulk-actions")?.addEventListener("click", async (event) => {
    const ids = [...list.querySelectorAll("[data-select-paper]:checked")].map((input) => input.dataset.selectPaper).filter(Boolean);
    const target = event.target.closest("button");
    if (!ids.length || !target) return;
    if (target.dataset.bulkTags !== undefined) {
      const name = window.prompt("Tag to add or remove:");
      if (!name?.trim()) return;
      const action = window.confirm(`Add “${name.trim()}” to ${ids.length} selected paper${ids.length === 1 ? "" : "s"}? Choose Cancel to remove it.`) ? "add" : "remove";
      try { await request("/api/papers/bulk-tags", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedIds: ids, name, action }) }); await loadPapers(); }
      catch (error) { setStatus(document.querySelector("#list-status"), error.message, true); }
      return;
    }
    if (!confirm(`Delete ${ids.length} selected paper${ids.length === 1 ? "" : "s"} and their PDFs?`)) return;
    target.disabled = true;
    try { setStatus(document.querySelector("#list-status"), `Deleting ${ids.length} paper${ids.length === 1 ? "" : "s"}…`); await request("/api/papers/bulk-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedIds: ids }) }); await loadPapers(); }
    catch (error) { setStatus(document.querySelector("#list-status"), error.message, true); target.disabled = false; }
  });
  form.addEventListener("submit", (event) => { event.preventDefault(); const data = new FormData(form); window.location.href = libraryUrl(libraryState(), { q: String(data.get("q") || "").trim(), sort: String(data.get("sort") || "newest"), page: 1 }); });
  const clear = document.querySelector("[data-clear-search]");
  const search = document.querySelector("#search");
  const updateClear = () => { if (clear) clear.hidden = !search?.value; };
  search?.addEventListener("input", updateClear); clear?.addEventListener("click", () => { if (search) search.value = ""; updateClear(); }); updateClear();
  loadPapers();
}

let hostedStaged;

function renderHostedPreview(data) {
  const preview = document.querySelector("#import-preview");
  if (!preview) return;
  hostedStaged = data;
  const form = document.querySelector("#paper-form-new");
  const paper = data.paper || {};
  const setValue = (name, value) => { const input = form?.elements.namedItem(name); if (input) input.value = value || ""; };
  setValue("title", paper.title);
  setValue("authors", (paper.authors || []).join("\n"));
  setValue("year", paper.year);
  setValue("publishedDate", paper.publishedDate);
  setValue("abstract", paper.abstract);
  setValue("primaryCategory", paper.primaryCategory);
  setValue("categories", (paper.categories || []).join(", "));
  setValue("journalRef", paper.journalRef);
  setValue("acceptedVenue", paper.acceptedVenue);
  setValue("doi", paper.doi);
  setValue("arxivId", paper.arxivId);
  setValue("sourceUrl", paper.sourceUrl || paper.arxivUrl);
  setValue("tags", (paper.tags || []).join(", "));
  const existingStagingToken = form?.elements.namedItem("stagingToken")?.value || "";
  const activeStagingToken = data.pdf?.stagingToken || existingStagingToken;
  setValue("stagingToken", activeStagingToken);
  const stagedPdfLink = form?.querySelector("[data-paper-pdf-link]");
  if (stagedPdfLink) {
    stagedPdfLink.hidden = !activeStagingToken;
    if (activeStagingToken) stagedPdfLink.href = `/api/staging/${encodeURIComponent(activeStagingToken)}/pdf`;
  }
  const sourceUrl = form?.querySelector("[data-source-url-go]");
  const source = paper.sourceUrl || paper.arxivUrl || (paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "");
  if (sourceUrl) { sourceUrl.hidden = !/^https?:\/\//i.test(source); if (!sourceUrl.hidden) sourceUrl.href = source; }
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
    journalRef: get("journalRef"), acceptedVenue: get("acceptedVenue"), doi: get("doi"), arxivId: get("arxivId"),
    sourceUrl: get("sourceUrl"), tags: get("tags").split(",").map((value) => value.trim()).filter(Boolean),
    stagingToken: get("stagingToken"), metadataSource: get("arxivId") ? "mixed" : "manual",
  };
}

document.querySelectorAll("[data-paper-form]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector(`[data-form-status-for="${form.id}"]`);
  setStatus(status, "Saving…");
  try {
    const saved = await request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(hostedPaperBody(form)) });
    window.location.href = `/papers/${encodeURIComponent(saved.paper.id)}`;
  } catch (error) {
    setStatus(status, error.message, true);
  }
}));

document.querySelectorAll("[data-lookup-metadata]").forEach((button) => button.addEventListener("click", async () => {
  const form = document.querySelector(`#${button.getAttribute("form") || "paper-form-new"}`);
  const status = document.querySelector(`[data-form-status-for="${form?.id}"]`);
  if (!form) return;
  const get = (name) => form.elements.namedItem(name)?.value || "";
  const input = get("arxivId") || get("doi") || get("title");
  if (!input.trim()) return setStatus(status, "Enter a title, DOI, or arXiv ID first.", true);
  button.disabled = true;
  try {
    setStatus(status, "Looking up citation metadata…");
    const body = await request("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input }) });
    if (body.duplicate) throw new Error("That paper is already in the library.");
    renderHostedPreview(body);
    setStatus(status, "Metadata found. Review it, then save.");
  } catch (error) {
    setStatus(status, error.message, true);
  } finally {
    button.disabled = false;
  }
}));

document.querySelectorAll("[data-extract-abstract]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.closest("[data-paper-form]");
  const status = document.querySelector(`[data-form-status-for="${form?.id}"]`);
  const stagingToken = form?.elements.namedItem("stagingToken")?.value || "";
  if (!stagingToken) return setStatus(status, "Upload or stage a PDF before extracting its abstract.", true);
  button.disabled = true;
  try {
    setStatus(status, "Extracting the abstract from the PDF…");
    const body = await request("/api/abstract/extract", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stagingToken }) });
    form.elements.namedItem("abstract").value = body.abstract || "";
    setStatus(status, "Abstract extracted from the PDF. Review it before saving.");
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
  const status = document.querySelector(`[data-form-status-for="${form.id}"]`);
  setStatus(status, `${selected.length} suggested tag${selected.length === 1 ? "" : "s"} added. Review before saving.`);
}));

document.querySelector("[data-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Uploading PDF…");
  try {
    const body = await request("/api/uploads", { method: "POST", body: new FormData(form) });
    const file = form.querySelector("input[type=file]").files[0];
    renderHostedPreview({ paper: { title: file.name.replace(/\.pdf$/i, "").replace(/[._]+/g, " ").trim() }, pdf: body.pdf });
    setStatus(form, "PDF ready. Add its metadata below.");
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
    if (folderZipInput) folderZipInput.value = "";
    folderPdfInput.form.requestSubmit();
  }
});

folderZipInput?.addEventListener("change", () => {
  if (folderZipInput.files.length && folderZipInput.form) {
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
  const files = [...form.querySelectorAll("input[type=file]")].flatMap((input) => [...input.files]);
  const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name));
  const zipFiles = files.filter((file) => /\.zip$/i.test(file.name));
  if (!pdfFiles.length && !zipFiles.length) return setStatus(form, "Choose a folder or ZIP archive containing PDF files.", true);
  const importLabel = zipFiles.length ? `${pdfFiles.length ? `${pdfFiles.length} local PDF${pdfFiles.length === 1 ? "" : "s"} and ` : ""}PDFs from ZIP` : `${pdfFiles.length} PDF${pdfFiles.length === 1 ? "" : "s"}`;
  setStatus(form, `Importing ${importLabel}…`);
  try {
    const formData = new FormData();
    pdfFiles.forEach((file) => formData.append("files", file, file.name));
    zipFiles.forEach((file) => formData.append("files", file, file.name));
    const relativePath = pdfFiles[0]?.webkitRelativePath || "";
    const folderTag = relativePath.split("/").filter(Boolean)[0] || "";
    const archiveTag = zipFiles[0]?.name.replace(/\.zip$/i, "") || "";
    if (folderTag || archiveTag) formData.set("folderTag", folderTag || archiveTag);
    formData.set("useFolderAsTag", String(form.querySelector("[data-folder-tag-toggle]")?.checked ?? true));
    const body = await request("/api/bulk-upload", { method: "POST", body: formData });
    setStatus(form, `Imported ${body.imported.length}; skipped ${body.skipped.length}; failed ${body.failed.length}${body.folderTag ? `; tagged as “${body.folderTag}”` : ""}.`);
    const results = form.querySelector("[data-bulk-results]");
    if (results) results.innerHTML = [...body.imported.map((item) => `<div class="result-success">Imported: ${escapeHtml(item.title)}</div>`), ...body.skipped.map((item) => `<div class="result-muted">Skipped: ${escapeHtml(item.filename)} (${escapeHtml(item.reason)})</div>`), ...body.failed.map((item) => `<div class="result-error">Failed: ${escapeHtml(item.filename)} (${escapeHtml(item.reason)})</div>`)].join("");
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
  backupCreate?.addEventListener("click", async () => {
    backupCreate.disabled = true;
    try {
      setStatus(backupStatus, "Creating backup and copying PDFs to R2…");
      const result = await request("/api/backups", { method: "POST" });
      backupId.value = result.backupId;
      backupDownload.href = result.manifestUrl;
      backupDownload.hidden = false;
      setStatus(backupStatus, `Backup ready: ${result.papers} paper${result.papers === 1 ? "" : "s"}, ${result.pdfs} PDF${result.pdfs === 1 ? "" : "s"}. Expires ${new Date(result.expiresAt).toLocaleDateString()}.`);
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
    const cards = (body.hits || []).map((hit) => `<article class="ask-result"><h3><a href="/papers/${encodeURIComponent(hit.paper.id)}">${escapeHtml(hit.paper.title)}</a></h3><p class="muted ask-result-meta">${escapeHtml((hit.paper.authors || []).join(", ") || "No authors recorded")} · ${escapeHtml(hit.matchType)} · ${(Number(hit.score) * 100).toFixed(0)}% match</p>${hit.evidence || hit.paper.abstract ? `<p class="ask-evidence">${escapeHtml(hit.evidence || hit.paper.abstract)}</p>` : ""}</article>`).join("");
    results.innerHTML = `${warnings}<div class="ask-results-heading"><div><p class="eyebrow">Library query</p><p class="muted">${body.hits?.length || 0} result${body.hits?.length === 1 ? "" : "s"}.</p></div></div>${cards || `<div class="empty-state"><h2>No matching papers</h2><p class="muted">Try a broader idea or remove one of the tag filters.</p></div>`}`;
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
    if (abstract && paper.abstract) { abstract.textContent = paper.abstract; abstractSection.hidden = false; }
    const tagsSection = document.querySelector("#paper-tags-section");
    const tags = document.querySelector("#paper-tags");
    if (tags && paper.tags?.length) { tags.innerHTML = paper.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" "); if (tagsSection) tagsSection.hidden = false; }
    const existing = await request(`/api/papers/${encodeURIComponent(id)}/summary`);
    if (existing.summary?.status === "complete") summary.innerHTML = `<pre>${escapeHtml(existing.summary.content)}</pre>`;
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
    try { await runSummary(id, (heading, content) => { summary.innerHTML = `<pre>${escapeHtml(content)}</pre>`; setStatus(analysisStatus, `${heading} ready.`); }, button.dataset.summaryMode || "quick"); }
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
  const form = document.querySelector("#paper-edit-form");
  if (!form) return;
  const id = form.dataset.paperId;
  const status = document.querySelector("#paper-status");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(form);
      const body = { id, title: data.get("title"), authors: String(data.get("authors") || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean), tags: String(data.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean), abstract: data.get("abstract"), metadataSource: "manual" };
      await request(`/api/papers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      window.location.href = `/papers/${encodeURIComponent(id)}`;
    } catch (error) { setStatus(status, error.message, true); }
  });
  const replace = document.querySelector("#replace-upload-form");
  replace?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = replace.elements.file.files?.[0];
    if (!file) return;
    try {
      setStatus(document.querySelector("#replace-status"), "Uploading replacement PDF…");
      const upload = await request("/api/uploads", { method: "POST", body: new FormData(replace) });
      await request(`/api/papers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: form.elements.title.value, authors: String(form.elements.authors.value || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean), tags: String(form.elements.tags.value || "").split(",").map((value) => value.trim()).filter(Boolean), abstract: form.elements.abstract.value, stagingToken: upload.pdf.stagingToken, metadataSource: "manual" }) });
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
  let staged;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      setStatus(status, "Looking up arXiv metadata and PDF…");
      staged = await request("/api/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: form.elements.input.value }),
      });
      renderHostedPreview(staged);
      setStatus(pdfStatus, staged.pdf?.status === "staged" ? "PDF staged" : "Metadata only");
      const pdfMessage = staged.pdf?.status === "staged" ? "Metadata found and PDF staged." : "Metadata found; save will create a metadata-only paper.";
      setStatus(status, staged.warnings?.length ? `${pdfMessage} ${staged.warnings.join(" ")}` : pdfMessage);
    } catch (error) {
      staged = undefined;
      preview.hidden = true;
      setStatus(status, error.message, true);
    }
  });
}

initLibrary();
initSettings();
initAsk();
initPaper();
initEdit();
initImport();
