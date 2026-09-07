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
  mint: "#f6fdfa",
};
const contentWidthOptions = ["50", "60", "70", "80", "90", "100"];
const pageSizeOptions = ["10", "25", "50", "100"];

function mixHexColors(hex, target, amount) {
  const value = hex.slice(1);
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16));
  return `#${channels.map((channel, index) => Math.round(channel + (target[index] - channel) * amount).toString(16).padStart(2, "0")).join("")}`;
}

function relativeLuminance(hex) {
  const value = hex.slice(1);
  const channels = [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function deriveBackgroundColors(background) {
  const isLight = relativeLuminance(background) > 0.5;
  const darkTarget = isLight ? [0, 0, 0] : [255, 255, 255];
  const lightTarget = isLight ? [255, 255, 255] : [0, 0, 0];
  return {
    sectionColor: mixHexColors(background, darkTarget, isLight ? 0.52 : 0.58),
    sectionSurface: mixHexColors(background, lightTarget, 0.22),
    sectionBorder: mixHexColors(background, darkTarget, 0.14),
  };
}

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
  const derivedColors = deriveBackgroundColors(selectedBackground);
  const contentWidth = contentWidthOptions.includes(String(theme.contentWidth)) ? String(theme.contentWidth) : "90";
  const pageSize = pageSizeOptions.includes(String(theme.pageSize)) ? String(theme.pageSize) : "50";
  document.documentElement.style.setProperty("--accent", selectedAccent.accent);
  document.documentElement.style.setProperty("--accent-dark", selectedAccent.dark);
  document.documentElement.style.setProperty("--accent-soft", selectedAccent.soft);
  document.documentElement.style.setProperty("--accent-border", selectedAccent.border);
  document.documentElement.style.setProperty("--page-bg", selectedBackground);
  document.documentElement.style.setProperty("--muted", derivedColors.sectionColor);
  document.documentElement.style.setProperty("--section-color", derivedColors.sectionColor);
  document.documentElement.style.setProperty("--section-surface", derivedColors.sectionSurface);
  document.documentElement.style.setProperty("--section-border", derivedColors.sectionBorder);
  document.documentElement.style.setProperty("--border", derivedColors.sectionBorder);
  document.querySelectorAll("[data-derived-color-swatch]").forEach((swatch) => {
    const color = derivedColors[swatch.dataset.derivedColorSwatch];
    if (!color) return;
    const isBorderSwatch = swatch.classList.contains("derived-color-swatch-border");
    swatch.style.backgroundColor = isBorderSwatch ? selectedBackground : color;
    swatch.style.borderColor = isBorderSwatch ? color : "var(--section-border)";
    swatch.style.borderWidth = isBorderSwatch ? "3px" : "1px";
  });
  document.querySelectorAll("[data-derived-color-value]").forEach((value) => {
    const color = derivedColors[value.dataset.derivedColorValue];
    if (color) value.textContent = color;
  });
  document.querySelectorAll("[data-theme-setting]").forEach((input) => {
    const setting = input.dataset.themeSetting;
    const selected = setting === "accent" ? accentKey : setting === "background" ? backgroundKey : setting === "contentWidth" ? contentWidth : pageSize;
    input.checked = input.value === selected;
  });
  document.documentElement.style.setProperty("--content-width", `${contentWidth}%`);
  document.querySelectorAll("[data-theme-picker]").forEach((input) => {
    input.value = input.dataset.themePicker === "accent" ? customAccent : customBackground;
  });
}

let selectedTheme = loadTheme();
applyTheme(selectedTheme);

const libraryPageSize = document.querySelector("[data-library-page-size]");
if (libraryPageSize && !new URLSearchParams(window.location.search).has("pageSize")) {
  const savedPageSize = pageSizeOptions.includes(String(selectedTheme.pageSize)) ? String(selectedTheme.pageSize) : "50";
  if (libraryPageSize.dataset.libraryPageSize !== savedPageSize) {
    const url = new URL(window.location.href);
    url.searchParams.set("pageSize", savedPageSize);
    url.searchParams.delete("page");
    window.location.replace(url);
  }
}

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
  if (error instanceof Error && /load failed|failed to fetch|networkerror/i.test(error.message)) return "The library server connection failed. Check that it is running, then retry.";
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

const restoreBackupForm = document.querySelector("[data-restore-backup]");
const restoreBackupInput = restoreBackupForm?.querySelector("[data-restore-backup-input]");
restoreBackupForm?.querySelector("[data-restore-backup-trigger]")?.addEventListener("click", () => {
  if (!restoreBackupInput) return;
  restoreBackupInput.value = "";
  restoreBackupInput.click();
});
restoreBackupInput?.addEventListener("change", () => {
  if (restoreBackupInput.files?.length) restoreBackupForm.requestSubmit();
});

restoreBackupForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!window.confirm("Restore this backup? Existing papers will be preserved and matching records will be skipped.")) return;
  setStatus(form, "Restoring backup…");
  try {
    const body = await jsonRequest("/api/import/backup", { method: "POST", body: new FormData(form) });
    setStatus(form, `Restored ${body.restored} paper${body.restored === 1 ? "" : "s"}; skipped ${body.skipped}. Reloading…`);
    window.setTimeout(() => window.location.reload(), 400);
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

const aiSettingsForm = document.querySelector("[data-ai-settings]");
if (aiSettingsForm) {
  const keyStatus = aiSettingsForm.querySelector("[data-openai-key-status]");
  const clearKey = aiSettingsForm.querySelector("[data-clear-openai-key]");
  const ollamaModel = aiSettingsForm.elements.namedItem("ollamaModel");
  const ollamaBaseUrl = aiSettingsForm.elements.namedItem("ollamaBaseUrl");
  const ollamaModelStatus = aiSettingsForm.querySelector("[data-ollama-model-status]");
  const loadOllamaModelsButton = aiSettingsForm.querySelector("[data-load-ollama-models]");
  const preserveOllamaModel = (model) => {
    if (!ollamaModel || !model || [...ollamaModel.options].some((option) => option.value === model)) return;
    ollamaModel.value = model;
  };
  const loadOllamaModels = async (selectedModel = ollamaModel?.value || "") => {
    if (!ollamaModel || !ollamaBaseUrl) return;
    const baseUrl = ollamaBaseUrl.value.trim();
    if (!baseUrl) return;
    if (ollamaModelStatus) ollamaModelStatus.textContent = "Loading available models…";
    if (loadOllamaModelsButton) loadOllamaModelsButton.disabled = true;
    try {
      const body = await jsonRequest(`/api/settings/llm/ollama/models?baseUrl=${encodeURIComponent(baseUrl)}`);
      const models = Array.isArray(body.models) ? body.models : [];
      const current = selectedModel || ollamaModel.value;
      ollamaModel.replaceChildren(new Option("Choose an available model…", ""));
      if (current && !models.includes(current)) ollamaModel.add(new Option(`${current} (saved, unavailable)`, current));
      models.forEach((model) => ollamaModel.add(new Option(model, model)));
      ollamaModel.value = current;
      if (ollamaModelStatus) ollamaModelStatus.textContent = models.length ? `${models.length} model${models.length === 1 ? "" : "s"} available.` : "No Ollama models are installed.";
    } catch (error) {
      preserveOllamaModel(selectedModel);
      if (ollamaModelStatus) ollamaModelStatus.textContent = clientErrorMessage(error);
    } finally {
      if (loadOllamaModelsButton) loadOllamaModelsButton.disabled = false;
    }
  };
  const loadAiSettings = async () => {
    try {
      const settings = await jsonRequest("/api/settings/llm");
      aiSettingsForm.elements.namedItem("provider").value = settings.provider;
      aiSettingsForm.elements.namedItem("openaiModel").value = settings.openaiModel;
      aiSettingsForm.elements.namedItem("ollamaBaseUrl").value = settings.ollamaBaseUrl;
      preserveOllamaModel(settings.ollamaModel);
      await loadOllamaModels(settings.ollamaModel);
      if (keyStatus) keyStatus.textContent = settings.openaiConfigured ? `OpenAI key configured (${settings.openaiKeySource}).${settings.openaiKeyEditable ? " Replace or clear it below." : " It is managed externally and cannot be edited here."}` : "OpenAI key not configured.";
      if (clearKey) clearKey.disabled = !settings.openaiConfigured || !settings.openaiKeyEditable;
      const keyInput = aiSettingsForm.elements.namedItem("openaiApiKey");
      if (keyInput) keyInput.disabled = !settings.openaiKeyEditable;
    } catch (error) {
      if (keyStatus) keyStatus.textContent = clientErrorMessage(error);
    }
  };
  loadAiSettings();
  loadOllamaModelsButton?.addEventListener("click", () => loadOllamaModels());
  ollamaBaseUrl?.addEventListener("change", () => loadOllamaModels());
  aiSettingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = { provider: value(aiSettingsForm, "provider"), openaiModel: value(aiSettingsForm, "openaiModel"), ollamaBaseUrl: value(aiSettingsForm, "ollamaBaseUrl"), ollamaModel: value(aiSettingsForm, "ollamaModel") };
    const key = value(aiSettingsForm, "openaiApiKey");
    if (key) body.openaiApiKey = key;
    setStatus(aiSettingsForm, "Saving AI settings…");
    try {
      await jsonRequest("/api/settings/llm", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      aiSettingsForm.elements.namedItem("openaiApiKey").value = "";
      setStatus(aiSettingsForm, "AI settings saved.");
      await loadAiSettings();
    } catch (error) {
      setStatus(aiSettingsForm, clientErrorMessage(error), true);
    }
  });
  clearKey?.addEventListener("click", async () => {
    if (!window.confirm("Clear the stored OpenAI API key?")) return;
    try {
      await jsonRequest("/api/settings/llm/openai-key", { method: "DELETE" });
      setStatus(aiSettingsForm, "OpenAI key cleared.");
      await loadAiSettings();
    } catch (error) {
      setStatus(aiSettingsForm, clientErrorMessage(error), true);
    }
  });
}

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
  setValue(form, "acceptedVenue", paper.acceptedVenue);
  setValue(form, "doi", paper.doi);
  setValue(form, "arxivId", paper.arxivId);
  setValue(form, "sourceUrl", paper.sourceUrl || paper.arxivUrl);
  setValue(form, "tags", (paper.tags || []).join(", "));
  const activeStagingToken = stagingToken || data.pdf?.stagingToken || "";
  setValue(form, "stagingToken", activeStagingToken);
  updateWebResource(form, paper, data.pdf);
  const stagedPdfLink = form?.querySelector("[data-paper-pdf-link]");
  if (stagedPdfLink) {
    stagedPdfLink.hidden = !activeStagingToken;
    if (activeStagingToken) stagedPdfLink.href = `/api/staging/${encodeURIComponent(activeStagingToken)}/pdf`;
  }
  const pdfStatus = preview.querySelector("[data-pdf-status]");
  if (pdfStatus) pdfStatus.textContent = activeStagingToken ? "" : "Metadata only";
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

function renderTagSuggestions(form, suggestions, provider, model) {
  const panel = form?.querySelector("[data-tag-suggestions]");
  const list = panel?.querySelector("[data-tag-suggestion-list]");
  const status = panel?.querySelector("[data-tag-suggestions-status]");
  if (!panel || !list) return;
  panel.hidden = false;
  if (status) status.textContent = `${provider} · ${model}`;
  list.innerHTML = suggestions.length ? suggestions.map((suggestion) => `<label class="tag-suggestion"><input type="checkbox" checked data-tag-suggestion data-tag-name="${escapeText(suggestion.name)}"><span class="tag-suggestion-name">${escapeText(suggestion.name)}</span><span class="tag-suggestion-kind">${suggestion.existing ? "Existing" : "New"}</span>${suggestion.reason ? `<span class="tag-suggestion-reason">${escapeText(suggestion.reason)}</span>` : ""}</label>`).join("") : `<p class="muted">No specific tags were found for this abstract.</p>`;
  const applyButton = panel.querySelector("[data-apply-tag-suggestions]");
  if (applyButton) applyButton.hidden = !suggestions.length;
}

document.querySelectorAll("[data-suggest-tags]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.form || button.closest("[data-paper-form]");
  const abstract = value(form, "abstract").trim();
  if (!abstract) {
    setStatus(form, "Add an abstract before asking for tag suggestions.", true);
    return;
  }
  button.disabled = true;
  setStatus(form, "Suggesting tags…");
  try {
    const body = await jsonRequest("/api/tags/suggestions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: value(form, "title"), abstract, categories: commaValues(value(form, "categories")) }) });
    renderTagSuggestions(form, body.suggestions || [], body.provider || "AI", body.model || "");
    setStatus(form, body.suggestions?.length ? "Review the suggested tags below." : "No specific tags were found.");
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
    const panel = form?.querySelector("[data-tag-suggestions]");
    if (panel) panel.hidden = true;
  } finally {
    button.disabled = false;
  }
}));

document.querySelectorAll("[data-apply-tag-suggestions]").forEach((button) => button.addEventListener("click", () => {
  const form = button.closest("[data-paper-form]");
  const panel = button.closest("[data-tag-suggestions]");
  if (!form || !panel) return;
  const current = commaValues(value(form, "tags"));
  const selected = [...panel.querySelectorAll("[data-tag-suggestion]:checked")].map((input) => input.dataset.tagName || "");
  const names = [...current, ...selected].filter(Boolean).filter((name, index, values) => values.findIndex((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
  setValue(form, "tags", names.join(", "));
  panel.hidden = true;
  setStatus(form, `${selected.length} suggested tag${selected.length === 1 ? "" : "s"} added. Review before saving.`);
}));

document.querySelector("[data-import-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Looking up paper metadata…");
  try {
    const body = await jsonRequest("/api/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value(form, "input") }) });
    if (body.duplicate) {
      setStatus(form, "That paper is already in the library.");
      form.querySelector("[data-existing-paper]")?.remove();
      const preview = document.querySelector("[data-preview]");
      if (preview) preview.hidden = true;
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

const singlePdfInput = document.querySelector("[data-single-pdf-input]");
singlePdfInput?.addEventListener("change", () => {
  if (singlePdfInput.files.length && singlePdfInput.form) singlePdfInput.form.requestSubmit();
});

const folderPdfInput = document.querySelector("[data-folder-pdf-input]");
folderPdfInput?.addEventListener("change", () => {
  if (folderPdfInput.files.length && folderPdfInput.form) folderPdfInput.form.requestSubmit();
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
    results.innerHTML = [...body.imported.map((item) => `<div class="result-success">Imported: ${escapeText(item.title)}${item.warning ? ` <span class="result-muted">(${escapeText(item.warning)})</span>` : ""}</div>`), ...body.skipped.map((item) => `<div class="result-muted">Skipped: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`), ...body.failed.map((item) => `<div class="result-error">Failed: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`)].join("");
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
    primaryCategory: value(form, "primaryCategory"), categories: commaValues(value(form, "categories")), journalRef: value(form, "journalRef"), acceptedVenue: value(form, "acceptedVenue"),
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
    setValue(form, "acceptedVenue", result.paper.acceptedVenue);
    setValue(form, "doi", result.paper.doi);
    setValue(form, "arxivId", result.paper.arxivId);
    setValue(form, "sourceUrl", result.paper.sourceUrl || result.paper.arxivUrl);
    if (result.pdf?.stagingToken) {
      setValue(form, "stagingToken", result.pdf.stagingToken);
      const preview = form.closest("[data-preview]");
      const stagedPdfLink = form?.querySelector("[data-paper-pdf-link]");
      if (stagedPdfLink) {
        stagedPdfLink.hidden = false;
        stagedPdfLink.href = `/api/staging/${encodeURIComponent(result.pdf.stagingToken)}/pdf`;
      }
      const pdfStatus = preview?.querySelector("[data-pdf-status]");
      if (pdfStatus) pdfStatus.textContent = "";
    }
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
  const label = button.querySelector("span:last-child");
  if (label) {
    const previous = label.textContent;
    label.textContent = "Copied";
    window.setTimeout(() => { label.textContent = previous; }, 1500);
  }
}));

const paperDetail = document.querySelector("[data-paper-id]");
const paperId = paperDetail?.dataset.paperId;
const summaryStatus = paperDetail?.querySelector("[data-summary-status]");
const generateSummary = async (button) => {
  if (!paperId) return;
  button.disabled = true;
  if (summaryStatus) {
    summaryStatus.textContent = "Preparing summary…";
    summaryStatus.classList.remove("status-error");
  }
  const updateSummaryProgress = async () => {
    if (!summaryStatus) return;
    try {
      const body = await jsonRequest(`/api/papers/${encodeURIComponent(paperId)}/summary/progress`);
      const progress = body.progress;
      const appendixNote = progress.appendixExcluded ? " (appendix excluded)" : "";
      if (progress.phase === "digesting" && progress.total) summaryStatus.textContent = `Digesting chunk ${progress.current || 0} of ${progress.total}…${appendixNote}`;
      else if (progress.phase === "synthesizing") summaryStatus.textContent = "Synthesizing summary…";
    } catch {
      // The generation request remains the source of truth if progress polling fails.
    }
  };
  const progressTimer = window.setInterval(() => { void updateSummaryProgress(); }, 750);
  void updateSummaryProgress();
  try {
    await jsonRequest(`/api/papers/${encodeURIComponent(paperId)}/summary`, { method: "POST" });
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    if (summaryStatus) { summaryStatus.textContent = clientErrorMessage(error); summaryStatus.classList.add("status-error"); }
  } finally {
    window.clearInterval(progressTimer);
  }
};
document.querySelectorAll("[data-generate-summary], [data-regenerate-summary]").forEach((button) => button.addEventListener("click", () => generateSummary(button)));

function formatAnalysisDuration(durationMs) {
  if (typeof durationMs !== "number") return "";
  return ` · ${Math.floor(durationMs / 60000)}:${String(Math.floor(durationMs / 1000) % 60).padStart(2, "0")}`;
}

function typesetMath(root) {
  const mathJax = window.MathJax;
  if (!mathJax) return;
  const typeset = () => {
    if (typeof mathJax.typesetPromise === "function") void mathJax.typesetPromise([root]).catch(() => {});
  };
  if (mathJax.startup?.promise) void mathJax.startup.promise.then(typeset).catch(() => {});
  else typeset();
}

function showQuestionAnswer(item, answer, answerHtml) {
  if (!item || !answer) return;
  item.querySelector("p.question-empty, p.status-error, p.status-warning")?.remove();

  let content = item.querySelector(".question-answer");
  if (!content) {
    content = document.createElement("div");
    content.className = "analysis-content question-answer";
    item.querySelector(".question-actions")?.before(content);
  }
  content.innerHTML = answerHtml || escapeText(answer.content || "");

  let meta = item.querySelector(".question-answer-meta");
  if (!meta) {
    meta = document.createElement("p");
    meta.className = "analysis-meta question-answer-meta muted";
    item.querySelector(".question-actions")?.before(meta);
  }
  const generatedAt = new Date(answer.generatedAt).toLocaleString("en-GB");
  meta.textContent = `${answer.provider} · ${answer.model} · ${generatedAt}${formatAnalysisDuration(answer.durationMs)}`;

  const label = item.querySelector("[data-generate-question] span:last-child");
  if (label) label.textContent = "Regenerate answer";

  const group = item.closest("[data-question-group]");
  const progress = group?.querySelector(".question-progress");
  const questionItems = group ? [...group.querySelectorAll("[data-question-id]")] : [];
  const questionIndex = questionItems.indexOf(item);
  const dot = questionIndex >= 0 ? progress?.querySelectorAll(".question-progress-dot")[questionIndex] : null;
  dot?.classList.add("is-answered");
  if (progress && group) {
    const answered = group.querySelectorAll(".question-answer").length;
    const total = questionItems.length;
    progress.setAttribute("aria-label", `${answered} of ${total} questions answered`);
    progress.setAttribute("title", `${answered} of ${total} questions answered`);
  }
  typesetMath(item);
}

async function generateOneQuestion(button) {
  if (!paperId) return false;
  const item = button.closest("[data-question-id]");
  const status = item?.querySelector("[data-question-status]");
  button.disabled = true;
  if (status) {
    status.textContent = "Generating…";
    status.classList.remove("status-error");
  }
  try {
    const body = await jsonRequest(`/api/papers/${encodeURIComponent(paperId)}/questions/${encodeURIComponent(button.dataset.generateQuestion)}`, { method: "POST" });
    showQuestionAnswer(item, body.answer, body.answerHtml);
    button.disabled = false;
    if (status) {
      status.textContent = "Saved.";
      status.classList.remove("status-error");
    }
    return true;
  } catch (error) {
    button.disabled = false;
    item?.querySelector("p.question-empty")?.remove();
    if (status) { status.textContent = clientErrorMessage(error); status.classList.add("status-error"); }
    return false;
  }
}
document.querySelectorAll("[data-generate-question]").forEach((button) => button.addEventListener("click", () => generateOneQuestion(button)));
document.querySelectorAll("[data-delete-question]").forEach((button) => button.addEventListener("click", async () => {
  if (!paperId || !window.confirm("Delete this custom question and its answer?")) return;
  button.disabled = true;
  try {
    await jsonRequest(`/api/papers/${encodeURIComponent(paperId)}/questions/${encodeURIComponent(button.dataset.deleteQuestion)}`, { method: "DELETE" });
    window.location.reload();
  } catch (error) {
    button.disabled = false;
    const item = button.closest("[data-question-id]");
    const status = item?.querySelector("[data-question-status]");
    if (status) { status.textContent = clientErrorMessage(error); status.classList.add("status-error"); }
  }
}));
document.querySelector("[data-toggle-questions]")?.addEventListener("click", (event) => {
  const button = event.currentTarget;
  const groups = [...document.querySelectorAll("[data-question-group]")];
  const expand = groups.some((group) => !group.open);
  groups.forEach((group) => { group.open = expand; });
  button.setAttribute("aria-label", expand ? "Collapse all questions" : "Expand all questions");
  button.setAttribute("title", expand ? "Collapse all questions" : "Expand all questions");
  const icon = button.querySelector(".material-symbols-outlined");
  if (icon) icon.textContent = expand ? "unfold_less" : "unfold_more";
});
document.querySelectorAll("[data-collapse-section]").forEach((button) => button.addEventListener("click", () => {
  const section = button.closest("details");
  if (!section) return;
  section.open = false;
  section.querySelector("summary")?.focus();
}));
document.querySelector("[data-generate-all-questions]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const status = document.querySelector("[data-questions-status]");
  const buttons = [...document.querySelectorAll("[data-generate-question]")];
  const pendingButtons = buttons.filter((questionButton) => !questionButton.closest("[data-question-id]")?.querySelector(".question-answer"));
  const skipped = buttons.length - pendingButtons.length;
  button.disabled = true;
  if (!pendingButtons.length) {
    if (status) status.textContent = "All answers have already been generated.";
    button.disabled = false;
    return;
  }
  let completed = 0;
  let failed = 0;
  for (const questionButton of pendingButtons) {
    if (status) status.textContent = `Generating answer ${completed + failed + 1} of ${pendingButtons.length}…`;
    if (await generateOneQuestion(questionButton)) completed += 1; else failed += 1;
  }
  button.disabled = false;
  if (status) status.textContent = `Saved ${completed} answer${completed === 1 ? "" : "s"}${skipped ? `; skipped ${skipped} already generated` : ""}${failed ? `; ${failed} failed. Retry failed questions.` : "."}`;
});

document.querySelector("[data-add-question]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const detail = document.querySelector("[data-paper-id]");
  const id = detail?.dataset.paperId;
  if (!id) return;
  setStatus(form, "Adding question…");
  try {
    await jsonRequest(`/api/papers/${encodeURIComponent(id)}/questions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: value(form, "question") }) });
    window.location.reload();
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

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
