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
const renderScaleOptions = ["100", "90", "80", "70", "60", "50"];
const pageSizeOptions = ["5", "7", "10", "25", "50", "100"];

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
  const renderScale = renderScaleOptions.includes(String(theme.renderScale)) ? String(theme.renderScale) : "100";
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
  document.documentElement.style.setProperty("--render-scale", String(Number(renderScale) / 100));
  document.documentElement.style.setProperty("--render-width", `${10000 / Number(renderScale)}%`);
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
    const selected = setting === "accent" ? accentKey : setting === "background" ? backgroundKey : setting === "contentWidth" ? contentWidth : setting === "renderScale" ? renderScale : pageSize;
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

function updateLookupProgress(button, event, form) {
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
  if (event.message) setStatus(form, event.message);
}

function clearLookupProgress(button) {
  const host = button?.closest(".form-actions") || button?.closest("form") || button?.parentElement;
  const progress = host?.querySelector("[data-lookup-progress]");
  if (progress) progress.hidden = true;
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
  const localPdfLink = form?.querySelector("[data-paper-pdf-link]");
  const hasLocalPdf = localPdfLink && !localPdfLink.hidden;
  const available = !hasLocalPdf && !["staged", "preserved"].includes(pdf?.status) && /^https?:\/\//i.test(url);
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
  if (!window.confirm("Restore this snapshot? It will replace the current library. Restart the app after staging completes.")) return;
  setStatus(form, "Staging snapshot…");
  try {
    const body = await jsonRequest("/api/import/backup", { method: "POST", body: new FormData(form) });
    setStatus(form, body.restartRequired ? "Snapshot staged. Restart the app to replace the current library." : "Snapshot restored.");
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
      aiSettingsForm.elements.namedItem("openaiEmbeddingModel").value = settings.openaiEmbeddingModel;
      aiSettingsForm.elements.namedItem("ollamaBaseUrl").value = settings.ollamaBaseUrl;
      aiSettingsForm.elements.namedItem("ollamaEmbeddingModel").value = settings.ollamaEmbeddingModel;
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
    const body = { provider: value(aiSettingsForm, "provider"), openaiModel: value(aiSettingsForm, "openaiModel"), openaiEmbeddingModel: value(aiSettingsForm, "openaiEmbeddingModel"), ollamaBaseUrl: value(aiSettingsForm, "ollamaBaseUrl"), ollamaModel: value(aiSettingsForm, "ollamaModel"), ollamaEmbeddingModel: value(aiSettingsForm, "ollamaEmbeddingModel") };
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
  setValue(form, "isbn", paper.isbn);
  setValue(form, "arxivId", paper.arxivId);
  setValue(form, "sourceUrl", paper.sourceUrl || paper.arxivUrl);
  setValue(form, "tags", (paper.tags || []).join(", "));
  const existingStagingToken = form?.elements.namedItem("stagingToken")?.value || "";
  const activeStagingToken = stagingToken || data.pdf?.stagingToken || existingStagingToken;
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
  if (!response.ok) {
    const message = body.error?.message || "Request failed";
    throw new Error(body.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message);
  }
  return body;
}

async function jsonRequestWithLookupProgress(url, options, onProgress) {
  const response = await fetch(url, options);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/x-ndjson")) return jsonRequestResponse(response);
  const reader = response.body?.getReader();
  if (!reader) return jsonRequestResponse(response);
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
  if (!result?.ok) {
    const message = body.error?.message || "Request failed";
    throw new Error(body.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message);
  }
  return body;
}

async function jsonRequestResponse(response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body.error?.message || "Request failed";
    throw new Error(body.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message);
  }
  return body;
}

function jsonRequestWithUploadProgress(url, options, { onProgress, onUploadComplete } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(options?.method || "GET", url);
    if (options?.headers) Object.entries(options.headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded, event.total);
    };
    xhr.upload.onload = () => onUploadComplete?.();
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText || "{}"); } catch { /* The normal error below is more useful than a parse error. */ }
      if (xhr.status < 200 || xhr.status >= 300) {
        const message = body.error?.message || "Request failed";
        reject(new Error(body.error?.code === "D1_DAILY_LIMIT_EXCEEDED" ? `${message} No data was lost.` : message));
        return;
      }
      resolve(body);
    };
    xhr.onerror = () => reject(new Error("The library server connection failed. Check that it is running, then retry."));
    xhr.ontimeout = () => reject(new Error("Request timed out."));
    xhr.send(options?.body);
  });
}

function renderLibraryQueryResults(body) {
  const results = document.querySelector("[data-library-query-results]");
  if (!results) return;
  const hits = body.hits || [];
  const groups = body.groups || [];
  const coverage = body.coverage || {};
  const warnings = body.warnings || [];
  updateLibraryIndexStatus(coverage);
  const coverageText = `Found ${hits.length} paper${hits.length === 1 ? "" : "s"}. Indexed ${coverage.indexedPapers || 0} of ${coverage.totalPapers || 0}; ${coverage.summaryBackedPapers || 0} have completed summaries${coverage.missingAbstractPapers ? `; ${coverage.missingAbstractPapers} missing abstracts` : ""}.`;
  const warningHtml = warnings.length ? `<p class="status-warning ask-warning">${warnings.map(escapeText).join(" ")}</p>` : "";
  const groupHtml = groups.length ? `<section><div class="ask-results-heading"><h2>Themes</h2></div><div class="ask-group-list">${groups.map((group) => { const paperIds = [...new Set(group.paperIds || [])]; return `<article class="ask-group"><div class="ask-group-header"><div><h3>${escapeText(group.name)}</h3><p>${escapeText(group.description)}</p></div><a class="button button-secondary button-small ask-group-select" href="${escapeText(librarySelectionUrl(paperIds))}">Select ${paperIds.length} paper${paperIds.length === 1 ? "" : "s"}</a></div>${group.evidence ? `<p class="muted ask-group-evidence">${escapeText(group.evidence)}</p>` : ""}<div class="ask-paper-list">${paperIds.map((id, index) => { const hit = hits.find((item) => item.paper.id === id); return hit ? `${index ? `<hr class="ask-paper-divider">` : ""}<div class="ask-paper-row"><h4><a href="${escapeText(hit.paperUrl)}" target="_blank" rel="noreferrer">${escapeText(hit.paper.title)}</a></h4><p class="muted ask-paper-meta">${escapeText((hit.paper.authors || []).slice(0, 3).join(", "))}${hit.paper.year ? ` · ${escapeText(hit.paper.year)}` : ""}</p></div>` : ""; }).join("")}</div></article>`; }).join("")}</div></section>` : "";
  const hitHtml = hits.length ? `<section><div class="ask-results-heading"><div><h2>Relevant papers</h2><span class="muted">Ranked by semantic and keyword match</span></div><button class="button button-secondary button-small ask-select-results" type="button" data-library-select-results disabled>Select selected papers</button></div><div class="ask-result-list">${hits.map((hit) => `<article class="ask-result"><div class="ask-result-select-row"><input class="ask-result-checkbox" type="checkbox" value="${escapeText(hit.paper.id)}" aria-label="Select ${escapeText(hit.paper.title)}"><div class="ask-result-content"><h3><a href="${escapeText(hit.paperUrl)}" target="_blank" rel="noreferrer">${escapeText(hit.paper.title)}</a></h3><p class="muted ask-result-meta">${escapeText((hit.paper.authors || []).slice(0, 3).join(", "))}${hit.paper.year ? ` · ${escapeText(hit.paper.year)}` : ""} · ${escapeText(hit.matchType)}</p>${hit.evidence ? `<p class="ask-evidence-label">Relevant passage</p><p class="ask-evidence">${escapeText(hit.evidence)}</p>` : ""}</div></div></article>`).join("")}</div></section>` : `<div class="empty-state"><h2>No matching papers</h2><p class="muted">Try a broader idea or remove one of the tag filters.</p></div>`;
  results.innerHTML = `<div class="ask-results-heading"><div><p class="eyebrow">Library query</p><p class="muted">${escapeText(coverageText)}</p></div></div>${warningHtml}${groupHtml}${hitHtml}`;
  setupLibraryResultSelection();
  results.hidden = false;
}

function librarySelectionUrl(ids) {
  const params = new URLSearchParams();
  ids.forEach((id) => params.append("selected", id));
  return `/?${params.toString()}`;
}

function setupLibraryResultSelection() {
  const results = document.querySelector("[data-library-query-results]");
  const button = results?.querySelector("[data-library-select-results]");
  if (!results || !button) return;
  const checkboxes = [...results.querySelectorAll(".ask-result-checkbox")];
  const update = () => {
    const selected = checkboxes.filter((checkbox) => checkbox.checked);
    button.disabled = selected.length === 0;
    button.textContent = selected.length ? `Select ${selected.length} paper${selected.length === 1 ? "" : "s"}` : "Select selected papers";
  };
  checkboxes.forEach((checkbox) => checkbox.addEventListener("change", update));
  button.addEventListener("click", () => {
    const selected = checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
    if (selected.length) window.location.href = librarySelectionUrl(selected);
  });
  update();
}

function renderAbstractExtractionFailures(failures) {
  const section = document.querySelector("[data-library-abstract-failures]");
  const list = section?.querySelector("[data-library-abstract-failure-list]");
  if (!section || !list) return;
  if (!failures.length) {
    section.hidden = true;
    list.innerHTML = "";
    return;
  }
  list.innerHTML = failures.map((failure) => {
    const reason = failure.errorMessage === "ABSTRACT_NOT_FOUND" ? "No abstract was detected in the PDF." : failure.errorMessage === "PDF_NOT_FOUND" ? "No stored PDF is available; add one before retrying." : "Automatic extraction failed; add the abstract manually.";
    return `<li><a href="/papers/${encodeURIComponent(failure.paperId)}/edit" target="_blank" rel="noreferrer">${escapeText(failure.title)}</a><span class="muted">${escapeText(reason)}</span></li>`;
  }).join("");
  section.hidden = false;
}

function updateLibraryIndexStatus(coverage, activeProgress, abstractFailures) {
  const status = document.querySelector("[data-library-index-status]");
  const buttons = [...document.querySelectorAll("[data-library-index-continue]")];
  if (!coverage) return;
  const total = Number(coverage.totalPapers || 0);
  const indexed = Number(coverage.indexedPapers || 0);
  const pending = Number(coverage.pendingPapers || 0);
  const unavailable = Number(coverage.unavailablePapers || 0) + Number(coverage.failedPapers || 0);
  const missingAbstracts = Number(coverage.missingAbstractPapers || 0);
  const missing = Math.max(0, total - indexed);
  if (Array.isArray(abstractFailures)) renderAbstractExtractionFailures(abstractFailures);
  if (activeProgress?.active) {
    const processed = Number(activeProgress.processed || 0);
    const requested = Number(activeProgress.requested || activeProgress.total || 0);
    const eta = Number(activeProgress.etaSeconds);
    const phaseLabel = activeProgress.phase === "abstracts" ? "Extracting abstracts" : "Indexing papers";
    const etaText = Number.isFinite(eta) && eta > 0 ? ` · ETA about ${eta < 60 ? `${eta}s` : `${Math.ceil(eta / 60)} min`}` : " · ETA calculating…";
    const progressText = `${phaseLabel} ${processed} of ${requested} papers${etaText}`;
    if (status) status.textContent = progressText;
    if (libraryIndexStatusMessage) libraryIndexStatusMessage.textContent = progressText;
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  if (!total) {
    if (status) status.textContent = "Add papers to build the search index.";
    buttons.forEach((button) => { button.disabled = true; });
    return;
  }
  if (status) status.textContent = missing ? `${missing} paper${missing === 1 ? "" : "s"} not indexed${missingAbstracts ? ` · ${missingAbstracts} missing abstracts` : ""}${unavailable ? ` · ${unavailable} unavailable` : ""}` : missingAbstracts ? `All papers indexed · ${missingAbstracts} missing abstracts` : "All papers indexed";
  const indexLimits = buttons.map((button) => Number(button.dataset.indexLimit || 20));
  const smallestLimit = Math.min(...indexLimits);
  const availableWork = Math.max(pending, missingAbstracts);
  buttons.forEach((button) => {
    const limit = Number(button.dataset.indexLimit || 20);
    const canRun = availableWork > 0 && (limit === smallestLimit || availableWork >= limit);
    const batch = Math.min(limit, availableWork);
    const label = button.querySelector("[data-library-index-label]");
    if (label) label.textContent = canRun ? `Index ${batch} paper${batch === 1 ? "" : "s"}` : `Index ${limit} papers`;
    button.disabled = !canRun;
  });
}

const libraryQueryForm = document.querySelector("[data-library-query]");
const libraryQueryStatus = document.querySelector("[data-library-query-status]");
const libraryIndexStatusMessage = document.querySelector("[data-library-index-status-message]");
const libraryTagButtons = libraryQueryForm ? [...libraryQueryForm.querySelectorAll("[data-library-tag]")] : [];
const libraryTagAll = libraryQueryForm?.querySelector("[data-library-tag-all]");
const libraryTagModeButtons = libraryQueryForm ? [...libraryQueryForm.querySelectorAll("[data-library-tag-mode]")] : [];
const selectedLibraryTags = () => libraryTagButtons.filter((button) => button.getAttribute("aria-pressed") === "true").map((button) => button.dataset.libraryTag || "").filter(Boolean);
const selectedLibraryTagMode = () => libraryTagModeButtons.find((button) => button.getAttribute("aria-pressed") === "true")?.dataset.libraryTagMode || "or";
const updateLibraryTagButtons = () => {
  const selected = selectedLibraryTags();
  if (libraryTagAll) {
    libraryTagAll.classList.toggle("tag-selected", selected.length === 0);
    libraryTagAll.setAttribute("aria-pressed", String(selected.length === 0));
  }
  libraryTagButtons.forEach((button) => button.classList.toggle("tag-selected", button.getAttribute("aria-pressed") === "true"));
};
libraryTagAll?.addEventListener("click", () => {
  libraryTagButtons.forEach((button) => button.setAttribute("aria-pressed", "false"));
  updateLibraryTagButtons();
});
libraryTagButtons.forEach((button) => button.addEventListener("click", () => {
  button.setAttribute("aria-pressed", button.getAttribute("aria-pressed") === "true" ? "false" : "true");
  updateLibraryTagButtons();
}));
libraryTagModeButtons.forEach((button) => button.addEventListener("click", () => {
  libraryTagModeButtons.forEach((modeButton) => modeButton.setAttribute("aria-pressed", String(modeButton === button)));
  libraryTagModeButtons.forEach((modeButton) => modeButton.classList.toggle("tag-selected", modeButton === button));
}));
updateLibraryTagButtons();
jsonRequest("/api/library/search-index/progress").then((body) => updateLibraryIndexStatus(body.coverage || {}, body.progress, body.abstractFailures || [])).catch(() => {});
libraryQueryForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = value(libraryQueryForm, "query").trim();
  const tags = selectedLibraryTags();
  const submit = document.querySelector("[data-library-query-submit]");
  if (submit) submit.disabled = true;
  if (libraryQueryStatus) { libraryQueryStatus.textContent = "Searching the library…"; libraryQueryStatus.classList.remove("status-error"); }
  try {
    const body = await jsonRequest("/api/library/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, tags, tagMode: selectedLibraryTagMode(), group: true, limit: 20 }) });
    renderLibraryQueryResults(body);
    if (libraryQueryStatus) libraryQueryStatus.textContent = "Search complete.";
  } catch (error) {
    if (libraryQueryStatus) { libraryQueryStatus.textContent = clientErrorMessage(error); libraryQueryStatus.classList.add("status-error"); }
  } finally {
    if (submit) submit.disabled = false;
  }
});

libraryQueryForm?.querySelector("[data-library-query-rephrase]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const query = value(libraryQueryForm, "query").trim();
  if (!query) {
    if (libraryQueryStatus) { libraryQueryStatus.textContent = "Enter a question or search idea first."; libraryQueryStatus.classList.add("status-error"); }
    return;
  }
  button.disabled = true;
  if (libraryQueryStatus) { libraryQueryStatus.textContent = "Rephrasing the query…"; libraryQueryStatus.classList.remove("status-error"); }
  try {
    const body = await jsonRequest("/api/library/query/rephrase", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query }) });
    setValue(libraryQueryForm, "query", body.query);
    if (libraryQueryStatus) libraryQueryStatus.textContent = "Query rephrased. Review it, then ask.";
  } catch (error) {
    if (libraryQueryStatus) { libraryQueryStatus.textContent = clientErrorMessage(error); libraryQueryStatus.classList.add("status-error"); }
  } finally {
    button.disabled = false;
  }
});

const libraryIndexButtons = [...document.querySelectorAll("[data-library-index-continue]")];
let libraryIndexPolling = false;
libraryIndexButtons.forEach((button) => button.addEventListener("click", async () => {
  const limit = Number(button.dataset.indexLimit || 20);
  libraryIndexButtons.forEach((indexButton) => { indexButton.disabled = true; });
  libraryIndexPolling = true;
  if (libraryIndexStatusMessage) { libraryIndexStatusMessage.textContent = "Starting indexing…"; libraryIndexStatusMessage.classList.remove("status-error"); }
  const poll = (async () => {
    while (libraryIndexPolling) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!libraryIndexPolling) break;
      try {
        const progressBody = await jsonRequest("/api/library/search-index/progress");
        updateLibraryIndexStatus(progressBody.coverage || {}, progressBody.progress, progressBody.abstractFailures || []);
        if (!progressBody.progress?.active) break;
      } catch {
        // The indexing request remains the source of truth if a progress poll fails.
      }
    }
  })();
  try {
    const body = await jsonRequest("/api/library/search-index/continue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit }) });
    libraryIndexPolling = false;
    await poll;
    updateLibraryIndexStatus(body.coverage || {}, body.progress, body.abstractFailures || []);
    const abstracts = body.abstracts || {};
    if (libraryIndexStatusMessage) libraryIndexStatusMessage.textContent = abstracts.resolved ? `Indexing complete. Filled ${abstracts.resolved} missing abstract${abstracts.resolved === 1 ? "" : "s"}.` : abstracts.failed ? "Indexing complete. Some abstracts need manual attention below." : "Indexing complete.";
  } catch (error) {
    libraryIndexPolling = false;
    await poll;
    if (libraryIndexStatusMessage) { libraryIndexStatusMessage.textContent = clientErrorMessage(error); libraryIndexStatusMessage.classList.add("status-error"); }
    libraryIndexButtons.forEach((indexButton) => { indexButton.disabled = false; });
  }
}));

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
  const form = document.querySelector(`#${button.getAttribute("form")}`) || button.closest("[data-paper-form]");
  const panel = button.closest("[data-tag-suggestions]");
  if (!form || !panel) return;
  const current = commaValues(value(form, "tags"));
  const selected = [...panel.querySelectorAll("[data-tag-suggestion]:checked")].map((input) => input.dataset.tagName || "");
  const names = [...current, ...selected].filter(Boolean).filter((name, index, values) => values.findIndex((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase()) === index);
  setValue(form, "tags", names.join(", "));
  panel.hidden = true;
  if (form.dataset.paperId) void savePaperForm(form, { statusMessage: `${selected.length} suggested tag${selected.length === 1 ? "" : "s"} added and saved.` });
  else setStatus(form, `${selected.length} suggested tag${selected.length === 1 ? "" : "s"} added. Review before saving.`);
}));

document.querySelectorAll("[data-folder-tag-toggle]").forEach((toggle) => toggle.addEventListener("change", () => {
  const valueLabel = toggle.closest("[data-bulk-upload-form]")?.querySelector("[data-folder-tag-value]");
  if (valueLabel) valueLabel.textContent = String(toggle.checked);
}));

document.querySelector("[data-import-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  setLookupBusy(button, true);
  setStatus(form, "Looking up paper metadata…");
  try {
    const body = await jsonRequestWithLookupProgress("/api/import?progress=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value(form, "input") }) }, (progress) => updateLookupProgress(button, progress, form));
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
  } finally {
    clearLookupProgress(button);
    setLookupBusy(button, false);
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

document.querySelector("[data-bulk-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const source = form.dataset.bulkSource || (form.querySelector("[data-folder-zip-input]")?.files.length ? "zip" : "folder");
  const pdfFiles = source === "folder" ? [...(form.querySelector("[data-folder-pdf-input]")?.files || [])] : [];
  const zipFiles = source === "zip" ? [...(form.querySelector("[data-folder-zip-input]")?.files || [])] : [];
  if (!pdfFiles.length && !zipFiles.length) {
    setStatus(form, "Choose a folder or ZIP archive containing PDF files.");
    const results = form.querySelector("[data-bulk-results]");
    if (results) results.textContent = "";
    return;
  }
  const importLabel = source === "zip"
    ? "PDFs from ZIP"
    : `${pdfFiles.length} PDF${pdfFiles.length === 1 ? "" : "s"} from folder`;
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
    const useFolderAsTag = form.querySelector("[data-folder-tag-toggle]");
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
      formData.set("useFolderAsTag", String(useFolderAsTag?.checked ?? true));
      try {
        const body = isZip
          ? await jsonRequestWithUploadProgress("/api/bulk-upload", { method: "POST", body: formData }, {
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
          : await jsonRequest("/api/bulk-upload", { method: "POST", body: formData });
        imported.push(...body.imported); skipped.push(...body.skipped); failed.push(...body.failed);
        (body.folderTags || (body.folderTag ? [body.folderTag] : [])).forEach((tag) => appliedFolderTags.add(tag));
        if (isZip) setStatus(form, `Loaded ${body.discovered ?? imported.length} PDFs from ZIP; preparing metadata…`);
      } catch (error) {
        failed.push({ filename: file.name, reason: clientErrorMessage(error) });
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
    const metadata = imported.length
      ? await runLocalMetadataBatch(imported.map((item) => item.id), { statusElement: form.querySelector(".form-status"), progress })
      : { succeeded: 0, failed: 0 };
    const tagSummary = [...appliedFolderTags].join("\", \"");
    setStatus(form, `Imported ${imported.length}; metadata found for ${metadata.succeeded}; skipped ${skipped.length}; failed ${failed.length + metadata.failed}${tagSummary ? `; tagged as “${tagSummary}”` : ""}.`);
    const results = form.querySelector("[data-bulk-results]");
    results.innerHTML = [...imported.map((item) => `<div class="result-success">Imported: ${escapeText(item.title)}${item.warning ? ` <span class="result-muted">(${escapeText(item.warning)})</span>` : ""}</div>`), ...skipped.map((item) => `<div class="result-muted">Skipped: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`), ...failed.map((item) => `<div class="result-error">Failed: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`)].join("");
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

document.querySelectorAll("[data-paper-form]").forEach((form) => form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await savePaperForm(form, { redirect: !form.dataset.paperId });
}));

const autosaveStates = new WeakMap();
async function savePaperForm(form, { redirect = false, statusMessage = "Saved." } = {}) {
  setStatus(form, "Saving…");
  const body = {
    title: value(form, "title"), authors: value(form, "authors").split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    year: value(form, "year") || undefined, publishedDate: value(form, "publishedDate"), abstract: value(form, "abstract"),
    primaryCategory: value(form, "primaryCategory"), categories: commaValues(value(form, "categories")), journalRef: value(form, "journalRef"), acceptedVenue: value(form, "acceptedVenue"),
    doi: value(form, "doi"), isbn: value(form, "isbn"), arxivId: value(form, "arxivId"), sourceUrl: value(form, "sourceUrl"), tags: commaValues(value(form, "tags")),
    stagingToken: value(form, "stagingToken"), metadataSource: value(form, "arxivId") ? "mixed" : "manual",
  };
  const id = form.dataset.paperId;
  try {
    const result = await jsonRequest(id ? `/api/papers/${encodeURIComponent(id)}` : "/api/papers", { method: id ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (redirect) window.location.href = `/papers/${encodeURIComponent(result.paper.id)}`;
    else setStatus(form, statusMessage);
    return result;
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
    return null;
  }
}

function schedulePaperAutosave(form, delay = 650) {
  if (form.dataset.mode !== "edit") return;
  const state = autosaveStates.get(form) || { timer: 0, saving: false, queued: false };
  state.queued = true;
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(async () => {
    if (state.saving) return;
    state.saving = true;
    state.queued = false;
    await savePaperForm(form);
    state.saving = false;
    if (state.queued) schedulePaperAutosave(form, 0);
  }, delay);
  autosaveStates.set(form, state);
}

document.querySelectorAll("[data-paper-form][data-mode='edit']").forEach((form) => {
  form.addEventListener("input", () => schedulePaperAutosave(form));
  form.addEventListener("change", () => schedulePaperAutosave(form, 0));
});

document.querySelectorAll("[data-lookup-metadata]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.form || button.closest("[data-paper-form]");
  setLookupBusy(button, true);
  setStatus(form, "Looking up citation metadata…");
  try {
    const result = await jsonRequestWithLookupProgress("/api/metadata/lookup?progress=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: value(form, "title"), doi: value(form, "doi"), isbn: value(form, "isbn"), arxivId: value(form, "arxivId"), paperId: form?.dataset.paperId, stagingToken: value(form, "stagingToken"), preservePdf: Boolean(value(form, "stagingToken")) }) }, (progress) => updateLookupProgress(button, progress, form));
    setValue(form, "title", result.paper.title);
    setValue(form, "authors", (result.paper.authors || []).join("\n"));
    setValue(form, "year", result.paper.year);
    setValue(form, "publishedDate", result.paper.publishedDate);
    if (result.paper.abstract?.trim()) setValue(form, "abstract", result.paper.abstract);
    setValue(form, "primaryCategory", result.paper.primaryCategory);
    setValue(form, "categories", (result.paper.categories || []).join(", "));
    setValue(form, "journalRef", result.paper.journalRef);
    setValue(form, "acceptedVenue", result.paper.acceptedVenue);
    setValue(form, "doi", result.paper.doi);
    setValue(form, "isbn", result.paper.isbn);
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
    if (form.dataset.paperId) await savePaperForm(form, { statusMessage: `Metadata found via ${result.provider}; saved.${pdfMessage}${warningMessage}` });
    else setStatus(form, `Metadata found via ${result.provider}.${pdfMessage} Review it, then save.${warningMessage}`);
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
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
    const result = await jsonRequest("/api/metadata/bibtex", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bibtex: input.value }) });
    const metadata = result.metadata || {};
    if (metadata.title) setValue(form, "title", metadata.title);
    if (metadata.authors?.length) setValue(form, "authors", metadata.authors.join("\n"));
    if (metadata.year) setValue(form, "year", metadata.year);
    if (metadata.publishedDate) setValue(form, "publishedDate", metadata.publishedDate);
    if (metadata.abstract) setValue(form, "abstract", metadata.abstract);
    if (metadata.primaryCategory) setValue(form, "primaryCategory", metadata.primaryCategory);
    if (metadata.categories?.length) setValue(form, "categories", metadata.categories.join(", "));
    if (metadata.journalRef) setValue(form, "journalRef", metadata.journalRef);
    if (metadata.acceptedVenue) setValue(form, "acceptedVenue", metadata.acceptedVenue);
    if (metadata.doi) setValue(form, "doi", metadata.doi);
    if (metadata.isbn) setValue(form, "isbn", metadata.isbn);
    if (metadata.arxivId) setValue(form, "arxivId", metadata.arxivId);
    if (metadata.sourceUrl || metadata.arxivUrl) setValue(form, "sourceUrl", metadata.sourceUrl || metadata.arxivUrl);
    updateWebResource(form, metadata);
    if (form.dataset.paperId) await savePaperForm(form, { statusMessage: "BibTeX imported and saved." });
    else status.textContent = "BibTeX imported. Review the fields, then save.";
  } catch (error) {
    status.textContent = clientErrorMessage(error);
    status.classList.add("status-error");
  } finally {
    button.disabled = false;
  }
}));

document.querySelectorAll("[data-extract-abstract]").forEach((button) => button.addEventListener("click", async () => {
  const form = button.closest("[data-paper-form]");
  if (!form) return;
  const stagingToken = value(form, "stagingToken").trim();
  const paperId = form.dataset.paperId || "";
  if (!stagingToken && !paperId) {
    setStatus(form, "Upload or save a PDF before extracting its abstract.", true);
    return;
  }
  const label = button.querySelector("span:last-child");
  const previousLabel = label?.textContent || "Extract from PDF";
  button.disabled = true;
  if (label) label.textContent = "Extracting…";
  setStatus(form, "Extracting the abstract from the PDF…");
  try {
    const body = await jsonRequest("/api/abstract/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(stagingToken ? { stagingToken } : { paperId }) });
    setValue(form, "abstract", body.abstract);
    if (form.dataset.paperId) await savePaperForm(form, { statusMessage: "Abstract extracted and saved." });
    else setStatus(form, "Abstract extracted from the PDF. Review it before saving.");
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  } finally {
    button.disabled = false;
    if (label) label.textContent = previousLabel;
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
    if (paperForm?.dataset.paperId) await savePaperForm(paperForm, { statusMessage: "Replacement PDF staged and saved." });
    else setStatus(form, "Replacement staged. Save paper to apply it.");
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
const disclosureStateKey = paperId ? `personal-paper-library-disclosures:${paperId}` : "";
function restoreDisclosureState() {
  if (!disclosureStateKey) return;
  try {
    const saved = sessionStorage.getItem(disclosureStateKey);
    if (!saved) return;
    const states = JSON.parse(saved);
    if (!Array.isArray(states)) return;
    document.querySelectorAll("details").forEach((detail, index) => {
      if (typeof states[index] === "boolean") detail.open = states[index];
    });
    sessionStorage.removeItem(disclosureStateKey);
  } catch {
    // Disclosure state is a convenience; private browsing or blocked storage should not break the page.
  }
}
function saveDisclosureState() {
  if (!disclosureStateKey) return;
  try {
    sessionStorage.setItem(disclosureStateKey, JSON.stringify([...document.querySelectorAll("details")].map((detail) => detail.open)));
  } catch {
    // Ignore unavailable session storage.
  }
}
restoreDisclosureState();
const generateSummary = async (button) => {
  if (!paperId) return;
  const summaryMode = button.dataset.summaryMode === "full" ? "full" : "quick";
  const summaryButtons = paperDetail?.querySelectorAll("[data-generate-summary], [data-regenerate-summary]") || [];
  summaryButtons.forEach((summaryButton) => { summaryButton.disabled = true; });
  if (summaryStatus) {
    summaryStatus.textContent = summaryMode === "full" ? "Preparing full summary…" : "Preparing summary from the opening pages…";
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
    await jsonRequest(`/api/papers/${encodeURIComponent(paperId)}/summary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: summaryMode }) });
    saveDisclosureState();
    window.location.reload();
  } catch (error) {
    summaryButtons.forEach((summaryButton) => { summaryButton.disabled = false; });
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
  return new Promise((resolve) => {
    let attempts = 0;
    const typeset = () => {
      const mathJax = window.MathJax;
      if (typeof mathJax?.typesetPromise !== "function") {
        if (attempts++ < 200) window.setTimeout(typeset, 50);
        else resolve();
        return;
      }
      const run = () => { void mathJax.typesetPromise([root]).then(resolve, resolve); };
      if (mathJax.startup?.promise) void mathJax.startup.promise.then(run, resolve);
      else run();
    };
    typeset();
  });
}

document.querySelectorAll(".abstract, .analysis-content, .question-answer").forEach((root) => { void typesetMath(root); });

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
  const overviewDot = [...document.querySelectorAll("[data-question-overview-dot]")].find((dot) => dot.dataset.questionOverviewDot === item.dataset.questionId);
  overviewDot?.classList.add("is-answered");
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
    return body.answer;
  } catch (error) {
    button.disabled = false;
    item?.querySelector("p.question-empty")?.remove();
    if (status) { status.textContent = clientErrorMessage(error); status.classList.add("status-error"); }
    return null;
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
  event.stopPropagation();
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
  event.stopPropagation();
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
  const progress = createOperationProgress(status);
  let completed = 0;
  let failed = 0;
  const durations = [];
  const formatRemainingTime = (milliseconds) => {
    const seconds = Math.max(1, Math.ceil(milliseconds / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m${remainingSeconds ? ` ${remainingSeconds}s` : ""}`;
  };
  const updateProgress = () => {
    const finished = completed + failed;
    const remaining = pendingButtons.length - finished;
    const averageDuration = durations.length ? durations.reduce((total, duration) => total + duration, 0) / durations.length : 0;
    const estimate = averageDuration && remaining ? ` ETA ~${formatRemainingTime(averageDuration)} remaining` : "";
    if (status) status.textContent = `Generating answer ${Math.min(finished + 1, pendingButtons.length)} of ${pendingButtons.length}…${estimate}`;
    updateOperationProgress(progress, finished, pendingButtons.length);
  };
  updateProgress();
  await Promise.all(pendingButtons.map(async (questionButton) => {
    const startedAt = performance.now();
    if (await generateOneQuestion(questionButton)) completed += 1; else failed += 1;
    durations.push(performance.now() - startedAt);
    updateProgress();
  }));
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

document.querySelector("[data-batch-metadata]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const ids = JSON.parse(button.dataset.batchMetadataIds || "[]");
  button.disabled = true;
  try {
    await runLocalMetadataBatch(ids, { statusElement: document.querySelector("#list-status"), progress: createOperationProgress(document.querySelector("#list-status")) , reload: true });
  } catch (error) {
    setStatus(document.querySelector("#list-status"), clientErrorMessage(error), true);
    button.disabled = false;
  }
});

document.querySelector("[data-delete-group]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const all = button.dataset.deleteAll === "true";
  const untagged = button.dataset.deleteUntagged === "true";
  const query = button.dataset.deleteQuery;
  const tags = JSON.parse(button.dataset.deleteTags || "[]");
  const tagMode = button.dataset.deleteTagMode || "and";
  const selectedIds = JSON.parse(button.dataset.deleteSelectedIds || "[]");
  const count = button.dataset.deleteCount || "0";
  const selection = selectedIds.length ? "the selected papers" : all ? "all papers" : untagged ? "papers without tags" : tags.length ? `the selected tag group${tags.length > 1 ? "s" : ""}` : `the current search results`;
  if ((!query && !tags.length && !selectedIds.length && !all && !untagged) || !window.confirm(`Delete all ${count} papers in ${selection} and their stored PDFs?`)) return;
  button.disabled = true;
  try {
    await jsonRequest("/api/papers/bulk-delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: query, tags, tagMode, selectedIds, all, untagged }) });
    window.location.href = "/";
  } catch (error) {
    button.disabled = false;
    window.alert(clientErrorMessage(error));
  }
});

document.querySelectorAll("[data-select-paper]").forEach((input) => input.addEventListener("change", () => {
  const params = new URLSearchParams(window.location.search);
  params.delete("selected");
  document.querySelectorAll("[data-select-paper]:checked").forEach((selected) => params.append("selected", selected.dataset.selectPaper));
  window.location.href = `/?${params.toString()}`;
}));

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
  const tagMode = form.dataset.selectionTagMode || "and";
  const selectedIds = JSON.parse(form.dataset.selectionIds || "[]");
  if (action === "remove" && selectedTag === "__new__") {
    setStatus(form, "Choose an existing tag to remove.", true);
    return;
  }
  setStatus(form, "Updating tags…");
  try {
    await jsonRequest("/api/papers/bulk-tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: form.dataset.selectionQuery, tags, tagMode, selectedIds, all, untagged, name, action }) });
    window.location.reload();
  } catch (error) {
    setStatus(form, clientErrorMessage(error), true);
  }
});

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
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

async function enrichLocalPaperMetadata(id) {
  const current = (await jsonRequest(`/api/papers/${encodeURIComponent(id)}`)).paper;
  const lookup = await jsonRequest("/api/metadata/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: current.title, doi: current.doi, isbn: current.isbn, arxivId: current.arxivId, paperId: id, preservePdf: Boolean(current.r2Key) }),
  });
  const metadata = lookup.paper || {};
  await jsonRequest(`/api/papers/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: metadata.title || current.title,
      authors: metadata.authors?.length ? metadata.authors : current.authors || [],
      year: metadata.year || current.year,
      publishedDate: metadata.publishedDate || current.publishedDate,
      abstract: metadata.abstract || current.abstract,
      primaryCategory: metadata.primaryCategory || current.primaryCategory,
      categories: metadata.categories?.length ? metadata.categories : current.categories || [],
      journalRef: metadata.journalRef || current.journalRef,
      acceptedVenue: metadata.acceptedVenue || current.acceptedVenue,
      doi: metadata.doi || current.doi,
      isbn: metadata.isbn || current.isbn,
      arxivId: metadata.arxivId || current.arxivId,
      arxivUrl: metadata.arxivUrl || current.arxivUrl,
      sourceUrl: metadata.sourceUrl || metadata.arxivUrl || current.sourceUrl,
      tags: current.tags || [],
      metadataSource: metadata.metadataSource || "mixed",
      stagingToken: lookup.pdf?.stagingToken,
    }),
  });
  return lookup;
}

async function runLocalMetadataBatch(ids, { statusElement, progress, reload = false } = {}) {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return { succeeded: 0, failed: 0 };
  const durations = [];
  let cursor = 0;
  let finished = 0;
  let succeeded = 0;
  let failed = 0;
  const update = () => {
    const remaining = uniqueIds.length - finished;
    if (statusElement) statusElement.textContent = `Finding metadata ${Math.min(finished + 1, uniqueIds.length)} of ${uniqueIds.length}…${operationEta(durations, remaining)}`;
    updateOperationProgress(progress, finished, uniqueIds.length);
  };
  update();
  const worker = async () => {
    while (cursor < uniqueIds.length) {
      const index = cursor++;
      const started = performance.now();
      try { await enrichLocalPaperMetadata(uniqueIds[index]); succeeded += 1; } catch { failed += 1; }
      durations.push(performance.now() - started);
      finished += 1;
      update();
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, uniqueIds.length) }, () => worker()));
  updateOperationProgress(progress, uniqueIds.length, uniqueIds.length);
  if (statusElement) statusElement.textContent = `Metadata found for ${succeeded} of ${uniqueIds.length}${failed ? `; ${failed} failed.` : "."}`;
  if (reload) window.location.reload();
  return { succeeded, failed };
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
