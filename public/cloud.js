const form = document.querySelector("#paper-form");
const search = document.querySelector("#search");
const refresh = document.querySelector("#refresh");
const list = document.querySelector("#paper-list");
const listStatus = document.querySelector("#list-status");
const uploadStatus = document.querySelector("#upload-status");

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
  element.textContent = message;
  element.classList.toggle("status-error", error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollUntil(load, done, timeout = 120000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await load();
    if (done(value)) return value;
    await sleep(3000);
  }
  throw new Error("The analysis job is taking longer than expected. Refresh to check its status.");
}

function analysisResult(card) {
  return card.querySelector("[data-analysis-result]");
}

function showAnalysisResult(card, heading, content, error = false) {
  const result = analysisResult(card);
  result.className = `analysis-result${error ? " status-error" : ""}`;
  result.innerHTML = `<strong>${escapeHtml(heading)}</strong><pre>${escapeHtml(content)}</pre>`;
  result.hidden = false;
}

function paperCard(paper) {
  const tags = (paper.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(" ");
  const authors = (paper.authors || []).join(", ");
  return `<article class="paper-card"><div class="paper-card-main"><h2>${escapeHtml(paper.title)}</h2><p class="paper-meta muted">${escapeHtml(authors || "No authors recorded")}${paper.year ? ` · ${escapeHtml(paper.year)}` : ""}</p><div class="paper-tags">${tags}</div><p class="cloud-card-actions"><a class="button button-small" href="/api/papers/${encodeURIComponent(paper.id)}/pdf" target="_blank" rel="noreferrer">Open PDF</a><button class="button button-small" data-summary="${escapeHtml(paper.id)}" type="button">Generate summary</button><button class="button button-small" data-question="${escapeHtml(paper.id)}" type="button">Ask a question</button><button class="button button-small button-danger" data-delete="${escapeHtml(paper.id)}" type="button">Delete</button></p><div class="analysis-result" data-analysis-result hidden></div></div></article>`;
}

async function loadPapers() {
  setStatus(listStatus, "Loading…");
  try {
    const query = search.value.trim();
    const body = await request(`/api/papers?limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`);
    list.innerHTML = body.papers.length ? body.papers.map(paperCard).join("") : `<div class="empty-state"><p>No papers yet.</p></div>`;
    setStatus(listStatus, `${body.total} paper${body.total === 1 ? "" : "s"}`);
  } catch (error) {
    list.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    setStatus(listStatus, "Could not load the library", true);
  }
}

list.addEventListener("click", async (event) => {
  const summaryButton = event.target.closest("[data-summary]");
  if (summaryButton) {
    const card = summaryButton.closest(".paper-card");
    summaryButton.disabled = true;
    try {
      showAnalysisResult(card, "Summary", "Queued…");
      const queued = await request(`/api/papers/${encodeURIComponent(summaryButton.dataset.summary)}/summary`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "quick" }) });
      const progress = await pollUntil(
        () => request(`/api/papers/${encodeURIComponent(summaryButton.dataset.summary)}/summary/progress`),
        (value) => !value.job || ["complete", "error", "cancelled"].includes(value.job.status),
      );
      if (!progress.job || progress.job.status !== "complete") throw new Error(progress.job?.errorMessage || "Summary generation failed.");
      const summary = await request(`/api/papers/${encodeURIComponent(summaryButton.dataset.summary)}/summary`);
      showAnalysisResult(card, "Summary", summary.summary?.content || "The summary completed without content.");
      summaryButton.textContent = "Regenerate summary";
    } catch (error) {
      showAnalysisResult(card, "Summary unavailable", error.message, true);
    } finally {
      summaryButton.disabled = false;
    }
    return;
  }

  const questionButton = event.target.closest("[data-question]");
  if (questionButton) {
    const question = window.prompt("What would you like to ask about this paper?");
    if (!question?.trim()) return;
    const card = questionButton.closest(".paper-card");
    questionButton.disabled = true;
    try {
      showAnalysisResult(card, "Answer", "Queued…");
      const queued = await request(`/api/papers/${encodeURIComponent(questionButton.dataset.question)}/questions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: question.trim(), prompt: question.trim() }) });
      const questionId = queued.question?.id;
      if (!questionId) throw new Error("The question was not queued.");
      const answer = await pollUntil(
        async () => (await request(`/api/papers/${encodeURIComponent(questionButton.dataset.question)}/questions`)).questions.find((item) => item.id === questionId),
        (value) => value?.answer && ["complete", "error", "stale"].includes(value.answer.status),
      );
      if (!answer?.answer || answer.answer.status !== "complete") throw new Error(answer?.answer?.errorMessage || "Question generation failed.");
      showAnalysisResult(card, "Answer", answer.answer.content);
    } catch (error) {
      showAnalysisResult(card, "Answer unavailable", error.message, true);
    } finally {
      questionButton.disabled = false;
    }
    return;
  }

  const button = event.target.closest("[data-delete]");
  if (!button || !confirm("Delete this paper and its PDF?")) return;
  button.disabled = true;
  try {
    await request(`/api/papers/${encodeURIComponent(button.dataset.delete)}`, { method: "DELETE" });
    await loadPapers();
  } catch (error) {
    setStatus(listStatus, error.message, true);
    button.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const file = data.get("file");
  if (!(file instanceof File) || !file.size) return setStatus(uploadStatus, "Choose a PDF first.", true);
  const title = String(data.get("title") || "").trim();
  try {
    setStatus(uploadStatus, "Uploading PDF…");
    const upload = await request("/api/uploads", { method: "POST", body: data });
    const authors = String(data.get("authors") || "").split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
    const tags = String(data.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean);
    await request("/api/papers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, authors, tags, stagingToken: upload.pdf.stagingToken, metadataSource: "manual" }) });
    form.reset();
    setStatus(uploadStatus, "Paper saved.");
    await loadPapers();
  } catch (error) {
    setStatus(uploadStatus, error.message, true);
  }
});

let searchTimer;
search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadPapers, 250); });
refresh.addEventListener("click", loadPapers);
loadPapers();
