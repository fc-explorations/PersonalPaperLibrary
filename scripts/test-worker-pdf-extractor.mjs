#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN?.trim();
const ENDPOINT = ACCOUNT_ID
  ? `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/tomarkdown`
  : undefined;

const TEXT_PDF_URL = "https://arxiv.org/pdf/1706.03762";
const SCANNED_PDF_URL = "https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/scan-bad.pdf";
const ENCRYPTED_PDF_URL = "https://raw.githubusercontent.com/mozilla/pdf.js/master/test/pdfs/empty_protected.pdf";
const LARGE_PADDING_BYTES = 8 * 1024 * 1024;

function usageError(message) {
  throw new Error(`${message}\nSet CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, then run: npm run cf:test-pdf-extractor`);
}

async function download(url) {
  const response = await fetch(url, { headers: { "user-agent": "PersonalPaperLibrary-PdfExtractorProbe/1.0" } });
  if (!response.ok) throw new Error(`DOWNLOAD_${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function malformedPdf(pdf) {
  return pdf.subarray(0, Math.max(32, Math.floor(pdf.byteLength * 0.35)));
}

function oversizedPdf(pdf) {
  // Bytes after %%EOF are permitted by PDF readers and exercise upload/request size
  // without changing the document's page structure.
  return Buffer.concat([pdf, Buffer.alloc(LARGE_PADDING_BYTES, 0x20)]);
}

async function convertPdf(name, bytes) {
  const form = new FormData();
  form.set("files", new Blob([bytes], { type: "application/pdf" }), name);
  form.set("conversionOptions", JSON.stringify({ output: { format: "text" }, pdf: { metadata: false } }));

  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${API_TOKEN}` },
    body: form,
  });
  const elapsedMs = Math.round(performance.now() - started);
  const payload = await response.json();
  const result = Array.isArray(payload?.result) ? payload.result[0] : undefined;
  const outputCharacters = typeof result?.data === "string" ? result.data.trim().length : 0;
  return {
    name,
    inputBytes: bytes.byteLength,
    httpStatus: response.status,
    elapsedMs,
    success: payload?.success === true && result?.format === "text" && outputCharacters >= 200,
    format: result?.format,
    outputCharacters,
    firstLine: typeof result?.data === "string" ? result.data.split(/\r?\n/, 1)[0].slice(0, 160) : undefined,
    error: result?.error || (outputCharacters > 0 && outputCharacters < 200 ? "PDF_TEXT_INSUFFICIENT" : undefined) || (payload?.success === false ? payload?.errors : undefined),
  };
}

if (!ACCOUNT_ID || !API_TOKEN) usageError("Cloudflare credentials are missing.");

const tempPath = await mkdtemp(join(tmpdir(), "personal-paper-library-pdf-probe-"));
try {
  const [textPdf, scannedPdf, encryptedPdf] = await Promise.all([
    download(TEXT_PDF_URL),
    download(SCANNED_PDF_URL),
    download(ENCRYPTED_PDF_URL),
  ]);

  const cases = [
    { name: "text-with-appendix.pdf", bytes: textPdf },
    { name: "malformed-truncated.pdf", bytes: malformedPdf(textPdf) },
    { name: "encrypted-aes-256.pdf", bytes: encryptedPdf },
    { name: "scanned-image-only.pdf", bytes: scannedPdf },
    { name: "oversized-text.pdf", bytes: oversizedPdf(textPdf) },
  ];

  await Promise.all(cases.map(({ name, bytes }) => writeFile(join(tempPath, name), bytes)));
  const results = [];
  for (const { name, bytes } of cases) results.push(await convertPdf(name, bytes));

  console.log(JSON.stringify({
    endpoint: "Workers AI Markdown Conversion REST API",
    options: { outputFormat: "text", pdfMetadata: false },
    sourceFixtures: {
      textWithAppendix: TEXT_PDF_URL,
      scannedImageOnly: SCANNED_PDF_URL,
      encrypted: ENCRYPTED_PDF_URL,
      malformed: "truncated text-with-appendix fixture",
      oversized: `text-with-appendix fixture + ${LARGE_PADDING_BYTES} trailing bytes`,
    },
    results,
  }, null, 2));
} finally {
  await rm(tempPath, { recursive: true, force: true });
}
