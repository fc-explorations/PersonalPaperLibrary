const page = document.body.dataset.hostedPage || "library";

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
  element.textContent = message;
  element.classList.toggle("status-error", error);
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

async function runSummary(paperId, onUpdate) {
  onUpdate("Summary", "Queued…");
  await request(`/api/papers/${encodeURIComponent(paperId)}/summary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "quick" }) });
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

function paperCard(paper) {
  const tags = (paper.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ");
  const authors = (paper.authors || []).join(", ");
  return `<article class="paper-card"><div class="paper-card-main"><label class="paper-select"><input type="checkbox" data-select-paper="${escapeHtml(paper.id)}" aria-label="Select ${escapeHtml(paper.title)}"></label><h2><a href="/papers/${encodeURIComponent(paper.id)}">${escapeHtml(paper.title)}</a></h2><p class="paper-meta muted">${escapeHtml(authors || "No authors recorded")}${paper.year ? ` · ${escapeHtml(paper.year)}` : ""}</p><div class="paper-tags">${tags}</div><p class="cloud-card-actions"><a class="button button-small" href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noreferrer">Open PDF</a><button class="button button-small" data-summary="${escapeHtml(paper.id)}" type="button">Generate summary</button><button class="button button-small" data-question="${escapeHtml(paper.id)}" type="button">Ask a question</button><button class="button button-small button-danger" data-delete="${escapeHtml(paper.id)}" type="button">Delete</button></p><div class="analysis-result" data-analysis-result hidden></div></div></article>`;
}

async function loadPapers() {
  const search = document.querySelector("#search");
  const list = document.querySelector("#paper-list");
  const listStatus = document.querySelector("#list-status");
  if (!search || !list || !listStatus) return;
  setStatus(listStatus, "Loading…");
  try {
    const query = search.value.trim();
    const body = await request(`/api/papers?limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    list.innerHTML = body.papers.length ? body.papers.map(paperCard).join("") : `<div class="empty-state"><p>No papers yet.</p></div>`;
    setStatus(listStatus, `${body.total} paper${body.total === 1 ? "" : "s"}`);
    const bulkDelete = document.querySelector("#delete-selected");
    if (bulkDelete) { bulkDelete.disabled = true; bulkDelete.textContent = "Delete selected"; }
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    setStatus(listStatus, "Could not load the library", true);
  }
}

function initLibrary() {
  const form = document.querySelector("#paper-form");
  const list = document.querySelector("#paper-list");
  const search = document.querySelector("#search");
  const refresh = document.querySelector("#refresh");
  const bulkDelete = document.querySelector("#delete-selected");
  const uploadStatus = document.querySelector("#upload-status");
  if (!form || !list || !search || !refresh) return;
  const updateBulkState = () => {
    const selected = list.querySelectorAll("[data-select-paper]:checked").length;
    if (bulkDelete) { bulkDelete.disabled = selected === 0; bulkDelete.textContent = selected ? `Delete selected (${selected})` : "Delete selected"; }
  };
  list.addEventListener("change", (event) => { if (event.target.closest("[data-select-paper]")) updateBulkState(); });
  list.addEventListener("click", async (event) => {
    const summaryButton = event.target.closest("[data-summary]");
    if (summaryButton) {
      const result = summaryButton.closest(".paper-card").querySelector("[data-analysis-result]");
      summaryButton.disabled = true;
      try { await runSummary(summaryButton.dataset.summary, (heading, content) => showAnalysisResult(result, heading, content)); summaryButton.textContent = "Regenerate summary"; }
      catch (error) { showAnalysisResult(result, "Summary unavailable", error.message, true); }
      finally { summaryButton.disabled = false; }
      return;
    }
    const questionButton = event.target.closest("[data-question]");
    if (questionButton) {
      const question = window.prompt("What would you like to ask about this paper?");
      if (!question?.trim()) return;
      const result = questionButton.closest(".paper-card").querySelector("[data-analysis-result]");
      questionButton.disabled = true;
      try { await runQuestion(questionButton.dataset.question, question, (heading, content) => showAnalysisResult(result, heading, content)); }
      catch (error) { showAnalysisResult(result, "Answer unavailable", error.message, true); }
      finally { questionButton.disabled = false; }
      return;
    }
    const deleteButton = event.target.closest("[data-delete]");
    if (!deleteButton || !confirm("Delete this paper and its PDF?")) return;
    deleteButton.disabled = true;
    try { await request(`/api/papers/${encodeURIComponent(deleteButton.dataset.delete)}`, { method: "DELETE" }); await loadPapers(); }
    catch (error) { setStatus(document.querySelector("#list-status"), error.message, true); deleteButton.disabled = false; }
  });
  bulkDelete?.addEventListener("click", async () => {
    const ids = [...list.querySelectorAll("[data-select-paper]:checked")].map((input) => input.dataset.selectPaper).filter(Boolean);
    if (!ids.length || !confirm(`Delete ${ids.length} selected paper${ids.length === 1 ? "" : "s"} and their PDFs?`)) return;
    bulkDelete.disabled = true;
    try {
      setStatus(document.querySelector("#list-status"), `Deleting ${ids.length} paper${ids.length === 1 ? "" : "s"}…`);
      for (const id of ids) await request(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadPapers();
    } catch (error) { setStatus(document.querySelector("#list-status"), error.message, true); updateBulkState(); }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const files = data.getAll("file").filter((file) => file instanceof File && file.size);
    if (!files.length) return setStatus(uploadStatus, "Choose at least one PDF.", true);
    const title = String(data.get("title") || "").trim();
    if (files.length === 1 && !title) return setStatus(uploadStatus, "Enter a title for a single PDF.", true);
    try {
      const authors = String(data.get("authors") || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
      const tags = String(data.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean);
      let saved;
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setStatus(uploadStatus, `Uploading PDF ${index + 1} of ${files.length}…`);
        const uploadForm = new FormData(); uploadForm.set("file", file);
        const upload = await request("/api/uploads", { method: "POST", body: uploadForm });
        const filenameTitle = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
        saved = await request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: files.length === 1 ? title : filenameTitle || `Imported paper ${index + 1}`, authors, tags, stagingToken: upload.pdf.stagingToken, metadataSource: "manual" }) });
      }
      form.reset(); setStatus(uploadStatus, `${files.length} paper${files.length === 1 ? "" : "s"} saved.`); await loadPapers();
      if (files.length === 1 && saved?.paper?.id) window.location.href = `/papers/${encodeURIComponent(saved.paper.id)}`;
    } catch (error) { setStatus(uploadStatus, error.message, true); }
  });
  let searchTimer;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadPapers, 250); });
  refresh.addEventListener("click", loadPapers);
  loadPapers();
}

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
  const showCoverage = (coverage) => setStatus(coverageElement, `${coverage.indexedPapers} indexed · ${coverage.pendingPapers} pending · ${coverage.totalPapers} total`);
  const loadCoverage = async () => {
    try { showCoverage((await request("/api/search/coverage")).coverage); }
    catch (error) { setStatus(coverageElement, error.message, true); }
  };
  const renderResults = (body) => {
    const warnings = (body.warnings || []).map((warning) => `<p class="hosted-search-warning">${escapeHtml(warning)}</p>`).join("");
    const cards = (body.hits || []).map((hit) => `<article class="hosted-ask-result"><h2><a href="/papers/${encodeURIComponent(hit.paper.id)}">${escapeHtml(hit.paper.title)}</a></h2><p class="muted">${escapeHtml((hit.paper.authors || []).join(", ") || "No authors recorded")} · ${escapeHtml(hit.matchType)} · ${(Number(hit.score) * 100).toFixed(0)}% match</p><p>${escapeHtml(hit.evidence || hit.paper.abstract || "No supporting excerpt available.")}</p></article>`).join("");
    results.innerHTML = `${warnings}${cards || `<div class="empty-state"><p>No matching papers found.</p></div>`}`;
    results.hidden = false;
  };
  await loadCoverage();
  indexButton?.addEventListener("click", async () => {
    indexButton.disabled = true;
    try {
      setStatus(status, "Indexing pending papers…");
      const body = await request("/api/search/index", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 20 }) });
      showCoverage(body.coverage); setStatus(status, body.coverage.pendingPapers ? "Some papers remain pending; run indexing again to continue." : "Library index is ready.");
    } catch (error) { setStatus(status, error.message, true); }
    finally { indexButton.disabled = false; }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!query.value.trim()) return;
    try {
      setStatus(status, "Searching…");
      const body = await request("/api/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: query.value.trim(), limit: 20 }) });
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
    editForm.elements.title.value = paper.title; editForm.elements.authors.value = (paper.authors || []).join("\n"); editForm.elements.tags.value = (paper.tags || []).join(", "); editForm.elements.abstract.value = paper.abstract || "";
    const existing = await request(`/api/papers/${encodeURIComponent(id)}/summary`);
    if (existing.summary?.status === "complete") summary.innerHTML = `<pre>${escapeHtml(existing.summary.content)}</pre>`;
  } catch (error) { setStatus(paperStatus, error.message, true); }
  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = new FormData(editForm);
      const updated = await request(`/api/papers/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, title: data.get("title"), authors: String(data.get("authors") || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean), tags: String(data.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean), abstract: data.get("abstract"), metadataSource: "manual" }) });
      document.querySelector("#paper-title").textContent = updated.paper.title; setStatus(paperStatus, "Metadata saved.");
    } catch (error) { setStatus(paperStatus, error.message, true); }
  });
  document.querySelector("#paper-summary-button").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try { await runSummary(id, (heading, content) => { summary.innerHTML = `<pre>${escapeHtml(content)}</pre>`; setStatus(analysisStatus, `${heading} ready.`); }); }
    catch (error) { setStatus(analysisStatus, error.message, true); }
    finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#paper-question-button").addEventListener("click", async (event) => {
    const question = window.prompt("What would you like to ask about this paper?");
    if (!question?.trim()) return;
    event.currentTarget.disabled = true;
    try { await runQuestion(id, question, (heading, content) => { showAnalysisResult(answer, heading, content); setStatus(analysisStatus, `${heading} ready.`); }); }
    catch (error) { showAnalysisResult(answer, "Answer unavailable", error.message, true); setStatus(analysisStatus, error.message, true); }
    finally { event.currentTarget.disabled = false; }
  });
  document.querySelector("#paper-delete").addEventListener("click", async () => {
    if (!confirm("Delete this paper and its PDF?")) return;
    try { await request(`/api/papers/${encodeURIComponent(id)}`, { method: "DELETE" }); window.location.href = "/"; }
    catch (error) { setStatus(paperStatus, error.message, true); }
  });
}

async function initImport() {
  const form = document.querySelector("#import-form");
  if (!form) return;
  const status = document.querySelector("#import-status");
  const preview = document.querySelector("#import-preview");
  const save = document.querySelector("#import-save");
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
      document.querySelector("#import-title").textContent = staged.paper.title;
      document.querySelector("#import-authors").textContent = (staged.paper.authors || []).join(", ") || "No authors recorded";
      document.querySelector("#import-abstract").textContent = staged.paper.abstract || "No abstract returned.";
      preview.hidden = false;
      const pdfStatus = staged.pdf?.status === "staged" ? "Metadata found and PDF staged." : "Metadata found; save will create a metadata-only paper.";
      setStatus(status, staged.warnings?.length ? `${pdfStatus} ${staged.warnings.join(" ")}` : pdfStatus);
    } catch (error) {
      staged = undefined;
      preview.hidden = true;
      setStatus(status, error.message, true);
    }
  });

  save.addEventListener("click", async () => {
    if (!staged) return;
    save.disabled = true;
    try {
      const saved = await request("/api/papers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...staged.paper, stagingToken: staged.pdf?.stagingToken }),
      });
      window.location.href = `/papers/${encodeURIComponent(saved.paper.id)}`;
    } catch (error) {
      setStatus(status, error.message, true);
      save.disabled = false;
    }
  });
}

initLibrary();
initSettings();
initAsk();
initPaper();
initImport();
