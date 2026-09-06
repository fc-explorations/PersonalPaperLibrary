const themeStorageKey = "personal-paper-library-theme";
const accentThemes = {
  forest: { accent: "#315c52", dark: "#264b43", soft: "#eaf0ed", border: "#aabbb4" },
  blue: { accent: "#3d5a80", dark: "#2d4665", soft: "#e8eef5", border: "#aab9cb" },
  terracotta: { accent: "#9a4e36", dark: "#7d3d2b", soft: "#f5e9e4", border: "#d8b6aa" },
  plum: { accent: "#6b4c73", dark: "#553b5c", soft: "#eee8f0", border: "#c4b5c8" },
  slate: { accent: "#58606a", dark: "#434a52", soft: "#edf0f2", border: "#b7bec4" },
};
const backgroundThemes = {
  paper: "#f7f6f2",
  white: "#ffffff",
  "light-gray": "#eeeeec",
  warm: "#f3efe8",
  mint: "#e5f1ea",
};
const contentWidthOptions = ["50", "60", "70", "80", "90", "100"];

function loadTheme() {
  try {
    return JSON.parse(localStorage.getItem(themeStorageKey) || "{}");
  } catch {
    return {};
  }
}

function applyTheme(theme) {
  const accent = accentThemes[theme.accent] || accentThemes.forest;
  const background = backgroundThemes[theme.background] || backgroundThemes.paper;
  const customAccent = /^#[0-9a-f]{6}$/i.test(theme.customAccent || "") ? theme.customAccent : "#315c52";
  const customBackground = /^#[0-9a-f]{6}$/i.test(theme.customBackground || "") ? theme.customBackground : "#f7f6f2";
  const accentKey = accentThemes[theme.accent] ? theme.accent : theme.accent === "custom" ? "custom" : "forest";
  const backgroundKey = backgroundThemes[theme.background] ? theme.background : theme.background === "custom" ? "custom" : "paper";
  const selectedAccent = accentKey === "custom" ? { accent: customAccent, dark: `color-mix(in srgb, ${customAccent} 82%, black 18%)`, soft: `color-mix(in srgb, ${customAccent} 12%, white 88%)`, border: `color-mix(in srgb, ${customAccent} 48%, white 52%)` } : accent;
  const selectedBackground = backgroundKey === "custom" ? customBackground : background;
  const contentWidth = contentWidthOptions.includes(String(theme.contentWidth)) ? String(theme.contentWidth) : "90";
  document.documentElement.style.setProperty("--accent", selectedAccent.accent);
  document.documentElement.style.setProperty("--accent-dark", selectedAccent.dark);
  document.documentElement.style.setProperty("--accent-soft", selectedAccent.soft);
  document.documentElement.style.setProperty("--accent-border", selectedAccent.border);
  document.documentElement.style.setProperty("--page-bg", selectedBackground);
  document.querySelectorAll("[data-theme-setting]").forEach((input) => {
    const setting = input.dataset.themeSetting;
    const selected = setting === "accent" ? accentKey : setting === "background" ? backgroundKey : contentWidth;
    input.checked = input.value === selected;
  });
  document.documentElement.style.setProperty("--content-width", `${contentWidth}%`);
  document.querySelectorAll("[data-theme-picker]").forEach((input) => {
    input.value = input.dataset.themePicker === "accent" ? customAccent : customBackground;
  });
}

let selectedTheme = loadTheme();
applyTheme(selectedTheme);

document.querySelectorAll("[data-theme-setting]").forEach((input) => input.addEventListener("change", () => {
  selectedTheme = { ...selectedTheme, [input.dataset.themeSetting]: input.value };
  try {
    localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme));
  } catch {
    // The current page still updates even when storage is unavailable.
  }
  applyTheme(selectedTheme);
}));

document.querySelectorAll("[data-theme-picker]").forEach((input) => input.addEventListener("input", () => {
  const group = input.dataset.themePicker;
  const customKey = group === "accent" ? "customAccent" : "customBackground";
  selectedTheme = { ...selectedTheme, [group]: "custom", [customKey]: input.value };
  try {
    localStorage.setItem(themeStorageKey, JSON.stringify(selectedTheme));
  } catch {
    // The current page still updates even when storage is unavailable.
  }
  applyTheme(selectedTheme);
}));

function setStatus(form, message, error = false) {
  const status = form?.querySelector(".form-status") || (form?.id ? document.querySelector(`[data-form-status-for="${form.id}"]`) : null);
  if (status) {
    status.textContent = message;
    status.classList.toggle("status-error", error);
  }
}

function clientErrorMessage(error) {
  return error instanceof Error ? error.message : "Request failed";
}

function value(form, name) {
  return form.elements.namedItem(name)?.value || "";
}

function resizeAuthorsField(input) {
  if (!(input instanceof HTMLTextAreaElement)) return;
  const lineCount = Math.max(1, input.value.split(/\r?\n/).length);
  input.rows = Math.max(3, Math.min(lineCount, 10));
  input.style.overflowY = lineCount > 10 ? "auto" : "hidden";
}

function setValue(form, name, next) {
  const input = form.elements.namedItem(name);
  if (input) {
    input.value = next || "";
    if (name === "authors") resizeAuthorsField(input);
    if (name === "sourceUrl") updateSourceUrlAction(form);
  }
}

function commaValues(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function updateWebResource(form, paper, pdf) {
  const link = form?.querySelector("[data-web-resource]") || (form?.id ? document.querySelector(`[data-web-resource-for="${form.id}"]`) : null);
  if (!link) return;
  const doiUrl = paper?.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : "";
  const url = paper?.arxivUrl || doiUrl || paper?.sourceUrl || paper?.pdfUrl || "";
  const available = pdf?.status !== "staged" && /^https?:\/\//i.test(url);
  link.hidden = !available;
  if (available) link.href = url;
}

function updateSourceUrlAction(form) {
  const input = form?.elements.namedItem("sourceUrl");
  const link = form?.querySelector("[data-source-url-go]");
  if (!input || !link) return;
  const rawUrl = input.value.trim();
  let url = "";
  try {
    const parsed = new URL(rawUrl);
    if (/^https?:$/.test(parsed.protocol)) url = parsed.toString();
  } catch {
    // Keep the action hidden until the field contains a valid web URL.
  }
  link.hidden = !url;
  if (url) link.href = url;
}

document.querySelectorAll("textarea[name=authors]").forEach((input) => {
  resizeAuthorsField(input);
  input.addEventListener("input", () => resizeAuthorsField(input));
});

document.querySelectorAll("input[name=sourceUrl]").forEach((input) => {
  updateSourceUrlAction(input.form);
  input.addEventListener("input", () => updateSourceUrlAction(input.form));
});

function renderPreview(data, stagingToken = "") {
  const preview = document.querySelector("[data-preview]");
  if (!preview) return;
  preview.hidden = false;
  const form = preview.querySelector("[data-paper-form]");
  const paper = data.paper || {};
  setValue(form, "title", paper.title);
  setValue(form, "authors", (paper.authors || []).join("\n"));
  setValue(form, "year", paper.year);
  setValue(form, "publishedDate", paper.publishedDate);
  setValue(form, "abstract", paper.abstract);
  setValue(form, "primaryCategory", paper.primaryCategory);
  setValue(form, "categories", (paper.categories || []).join(", "));
  setValue(form, "journalRef", paper.journalRef);
  setValue(form, "doi", paper.doi);
  setValue(form, "arxivId", paper.arxivId);
  setValue(form, "sourceUrl", paper.sourceUrl || paper.arxivUrl);
  setValue(form, "tags", (paper.tags || []).join(", "));
  setValue(form, "stagingToken", stagingToken || data.pdf?.stagingToken);
  updateWebResource(form, paper, data.pdf);
  const pdfStatus = preview.querySelector("[data-pdf-status]");
  if (pdfStatus) pdfStatus.textContent = data.pdf?.status === "staged" ? "PDF ready" : "Metadata only";
  const warnings = preview.querySelector("[data-warnings]");
  if (warnings) warnings.textContent = (data.warnings || []).join(" ");
  preview.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || "Request failed");
  return body;
}

document.querySelector("[data-import-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Looking up paper metadata…");
  try {
    const body = await jsonRequest("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value(form, "input") }) });
    if (body.duplicate) {
      setStatus(form, "That paper is already in the library.");
      form.querySelector("[data-existing-paper]")?.remove();
      form.insertAdjacentHTML("beforeend", `<a class="inline-link" data-existing-paper href="/papers/${encodeURIComponent(body.existing.id)}">Open existing paper</a>`);
    } else {
      setStatus(form, "Review the details below.");
      renderPreview(body);
    }
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

document.querySelector("[data-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Uploading PDF…");
  try {
    const body = await jsonRequest("/api/uploads", { method: "POST", body: new FormData(form) });
    setStatus(form, "PDF ready. Add its metadata below.");
    renderPreview({ paper: { title: form.querySelector("input[type=file]").files[0].name.replace(/\.pdf$/i, "") }, pdf: body.pdf }, body.pdf.stagingToken);
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

document.querySelector("[data-bulk-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = [...form.querySelector("input[type=file]").files];
  const pdfFiles = files.filter((file) => /\.pdf$/i.test(file.name));
  if (!pdfFiles.length) {
    setStatus(form, "No PDF files found in the selected folder.");
    const results = form.querySelector("[data-bulk-results]");
    if (results) results.textContent = "";
    return;
  }
  setStatus(form, `Importing ${pdfFiles.length} PDF${pdfFiles.length === 1 ? "" : "s"}…`);
  try {
    const formData = new FormData(form);
    formData.delete("files");
    pdfFiles.forEach((file) => formData.append("files", file, file.name));
    const relativePath = pdfFiles[0]?.webkitRelativePath || "";
    const folderTag = relativePath.split("/").filter(Boolean)[0] || "";
    if (folderTag) formData.set("folderTag", folderTag);
    const body = await jsonRequest("/api/bulk-upload", { method: "POST", body: formData });
    setStatus(form, `Imported ${body.imported.length}; skipped ${body.skipped.length}; failed ${body.failed.length}${body.folderTag ? `; tagged as “${body.folderTag}”` : ""}.`);
    const results = form.querySelector("[data-bulk-results]");
    results.innerHTML = [...body.imported.map((item) => `<div class="result-success">Imported: ${escapeText(item.title)}${item.warning ? ` <span class="result-muted">(${escapeText(item.warning)})</span>` : ""}</div>`), ...body.skipped.map((item) => `<div class="result-muted">Skipped: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`), ...body.failed.map((item) => `<div class="result-error">Failed: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`), `<a class="inline-link" href="/">View library →</a>`].join("");
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

document.querySelectorAll("[data-paper-form]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus(form, "Saving…");
  const body = {
    title: value(form, "title"), authors: value(form, "authors").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    year: value(form, "year") || undefined, publishedDate: value(form, "publishedDate"), abstract: value(form, "abstract"),
    primaryCategory: value(form, "primaryCategory"), categories: commaValues(value(form, "categories")), journalRef: value(form, "journalRef"),
    doi: value(form, "doi"), arxivId: value(form, "arxivId"), sourceUrl: value(form, "sourceUrl"), tags: commaValues(value(form, "tags")),
    stagingToken: value(form, "stagingToken"), metadataSource: value(form, "arxivId") ? "mixed" : "manual",
  };
  const id = form.dataset.paperId;
  try {
    const result = await jsonRequest(id ? `/api/papers/${encodeURIComponent(id)}` : "/api/papers", { method: id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    window.location.href = `/papers/${encodeURIComponent(result.paper.id)}`;
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
}));

document.querySelectorAll("[data-lookup-metadata]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.form || button.closest("[data-paper-form]");
  setStatus(form, "Looking up citation metadata…");
  try {
    const result = await jsonRequest("/api/metadata/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: value(form, "title"), doi: value(form, "doi"), arxivId: value(form, "arxivId") }) });
    setValue(form, "title", result.paper.title);
    setValue(form, "authors", (result.paper.authors || []).join("\n"));
    setValue(form, "year", result.paper.year);
    setValue(form, "publishedDate", result.paper.publishedDate);
    setValue(form, "abstract", result.paper.abstract);
    setValue(form, "primaryCategory", result.paper.primaryCategory);
    setValue(form, "categories", (result.paper.categories || []).join(", "));
    setValue(form, "journalRef", result.paper.journalRef);
    setValue(form, "doi", result.paper.doi);
    setValue(form, "arxivId", result.paper.arxivId);
    setValue(form, "sourceUrl", result.paper.sourceUrl || result.paper.arxivUrl);
    if (result.pdf?.stagingToken) setValue(form, "stagingToken", result.pdf.stagingToken);
    updateWebResource(form, result.paper, result.pdf);
    const pdfMessage = result.pdf?.status === "staged" ? " PDF ready to store." : "";
    const warningMessage = result.warnings?.length ? ` ${result.warnings.join(" ")}` : "";
    setStatus(form, `Metadata found via ${result.provider}.${pdfMessage} Review it, then save.${warningMessage}`);
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
}));

document.querySelector("[data-replace-upload]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Staging replacement PDF…");
  try {
    const body = await jsonRequest("/api/uploads", { method: "POST", body: new FormData(form) });
    const paperForm = document.querySelector("[data-paper-form]");
    setValue(paperForm, "stagingToken", body.pdf.stagingToken);
    setStatus(form, "Replacement staged. Save changes to apply it.");
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
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
  const label = button.querySelector("span:last-child");
  if (label) {
    const previous = label.textContent;
    label.textContent = "Copied";
    window.setTimeout(() => { label.textContent = previous; }, 1500);
  }
}));

document.querySelector("[data-delete-paper]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!window.confirm("Delete this paper and its PDF?")) return;
  button.disabled = true;
  try {
    await jsonRequest(`/api/papers/${encodeURIComponent(button.dataset.deletePaper)}`, { method: "DELETE" });
    window.location.href = "/";
  } catch (error) {
    button.disabled = false;
    window.alert(clientErrorMessage(error));
  }
});

document.querySelector("[data-delete-group]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const all = button.dataset.deleteAll === "true";
  const untagged = button.dataset.deleteUntagged === "true";
  const query = button.dataset.deleteQuery;
  const tags = JSON.parse(button.dataset.deleteTags || "[]");
  const count = button.dataset.deleteCount || "0";
  const selection = all ? "all papers" : untagged ? "papers without tags" : tags.length ? `the selected tag group${tags.length > 1 ? "s" : ""}` : `the current search results`;
  if ((!query && !tags.length && !all && !untagged) || !window.confirm(`Delete all ${count} papers in ${selection} and their stored PDFs?`)) return;
  button.disabled = true;
  try {
    await jsonRequest("/api/papers/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: query, tags, all, untagged }) });
    window.location.href = "/";
  } catch (error) {
    button.disabled = false;
    window.alert(clientErrorMessage(error));
  }
});

document.querySelector("[data-toggle-bulk-tags]")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const editor = document.querySelector("[data-bulk-tag-editor]");
  const actions = document.querySelector("[data-bulk-actions]");
  if (!editor) return;
  editor.hidden = false;
  if (actions) actions.hidden = true;
  button.setAttribute("aria-expanded", "true");
  editor.querySelector("select")?.focus();
});

document.querySelector("[data-cancel-bulk-tags]")?.addEventListener("click", () => {
  const editor = document.querySelector("[data-bulk-tag-editor]");
  const actions = document.querySelector("[data-bulk-actions]");
  const toggle = document.querySelector("[data-toggle-bulk-tags]");
  if (editor) editor.hidden = true;
  if (actions) actions.hidden = false;
  toggle?.setAttribute("aria-expanded", "false");
});

document.querySelector("[data-bulk-tag-select]")?.addEventListener("change", (event) => {
  const select = event.currentTarget;
  const form = select.closest("form");
  const newTag = form?.querySelector("[data-new-tag]");
  if (!newTag) return;
  const isNew = select.value === "__new__";
  newTag.hidden = !isNew;
  newTag.required = isNew;
  if (isNew) newTag.focus();
});

document.querySelector("[data-bulk-tag-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const action = event.submitter?.dataset.bulkTagAction;
  const selectedTag = value(form, "tag");
  const name = selectedTag === "__new__" ? value(form, "newTag") : selectedTag;
  const all = form.dataset.selectionAll === "true";
  const untagged = form.dataset.selectionUntagged === "true";
  const tags = JSON.parse(form.dataset.selectionTags || "[]");
  if (action === "remove" && selectedTag === "__new__") {
    setStatus(form, "Choose an existing tag to remove.", true);
    return;
  }
  setStatus(form, "Updating tags…");
  try {
    await jsonRequest("/api/papers/bulk-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: form.dataset.selectionQuery, tags, all, untagged, name, action }) });
    window.location.reload();
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

const libraryToolbar = document.querySelector(".toolbar");
const searchInput = libraryToolbar?.querySelector("input[name=q]");
const clearSearch = libraryToolbar?.querySelector("[data-clear-search]");
const syncClearSearch = () => {
  if (clearSearch) clearSearch.hidden = !searchInput?.value;
};
searchInput?.addEventListener("input", syncClearSearch);
clearSearch?.addEventListener("click", () => {
  if (!searchInput) return;
  searchInput.value = "";
  syncClearSearch();
  searchInput.focus();
  libraryToolbar?.requestSubmit();
});
syncClearSearch();
libraryToolbar?.querySelector("select")?.addEventListener("change", () => {
  libraryToolbar.requestSubmit();
});
libraryToolbar?.querySelector("input")?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    libraryToolbar.requestSubmit();
  }
});
