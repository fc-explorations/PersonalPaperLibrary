function setStatus(form, message, error = false) {
  const status = form.querySelector(".form-status");
  if (status) {
    status.textContent = message;
    status.classList.toggle("status-error", error);
  }
}

function value(form, name) {
  return form.elements.namedItem(name)?.value || "";
}

function setValue(form, name, next) {
  const input = form.elements.namedItem(name);
  if (input) input.value = next || "";
}

function commaValues(text) {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
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
  setValue(form, "doi", paper.doi);
  setValue(form, "arxivId", paper.arxivId);
  setValue(form, "sourceUrl", paper.sourceUrl || paper.arxivUrl);
  setValue(form, "tags", (paper.tags || []).join(", "));
  setValue(form, "stagingToken", stagingToken || data.pdf?.stagingToken);
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

document.querySelector("[data-arxiv-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  setStatus(form, "Fetching metadata and PDF…");
  try {
    const body = await jsonRequest("/api/import/arxiv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: value(form, "input") }) });
    if (body.duplicate) {
      setStatus(form, "That paper is already in the library.");
      form.insertAdjacentHTML("beforeend", `<a class="inline-link" href="/papers/${encodeURIComponent(body.existing.id)}">Open existing paper</a>`);
    } else {
      setStatus(form, "Review the details below.");
      renderPreview(body);
    }
  } catch (error) {
    setStatus(form, error.message, true);
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
    setStatus(form, error.message, true);
  }
});

document.querySelector("[data-bulk-upload-form]")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const files = form.querySelector("input[type=file]").files;
  setStatus(form, `Importing ${files.length} PDF${files.length === 1 ? "" : "s"}…`);
  try {
    const body = await jsonRequest("/api/bulk-upload", { method: "POST", body: new FormData(form) });
    setStatus(form, `Imported ${body.imported.length}; skipped ${body.skipped.length}; failed ${body.failed.length}.`);
    const results = form.querySelector("[data-bulk-results]");
    results.innerHTML = [...body.imported.map((item) => `<div class="result-success">Imported: ${escapeText(item.title)}</div>`), ...body.skipped.map((item) => `<div class="result-muted">Skipped: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`), ...body.failed.map((item) => `<div class="result-error">Failed: ${escapeText(item.filename)} (${escapeText(item.reason)})</div>`)].join("");
  } catch (error) {
    setStatus(form, error.message, true);
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
    setStatus(form, error.message, true);
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
    setStatus(form, error.message, true);
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
    window.alert(error.message);
  }
});

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
