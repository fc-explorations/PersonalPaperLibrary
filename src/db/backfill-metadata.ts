import { openDatabase } from "./database.js";
import { PaperRepository } from "../repositories/papers.js";
import { FileStorage } from "../services/storage.js";
import { extractPdfMetadata } from "../services/pdf-metadata.js";
import { normalizeArxivInput, fetchArxivMetadata } from "../services/arxiv.js";
import { lookupCrossref } from "../services/crossref.js";

const db = openDatabase();
const repo = new PaperRepository(db);
const storage = new FileStorage();
let updated = 0;
let skipped = 0;

for (const paper of repo.list({ sort: "newest" })) {
  if (!paper.r2Key) {
    skipped++;
    continue;
  }
  const extracted = await extractPdfMetadata(storage.getPath(paper.id));
  let arxivMetadata: Awaited<ReturnType<typeof fetchArxivMetadata>> | undefined;
  if (extracted.arxivId) {
    const normalized = normalizeArxivInput(extracted.arxivId);
    if (normalized) {
      try {
        arxivMetadata = await fetchArxivMetadata(normalized);
      } catch {
        // Keep the local first-page extraction when arXiv is unavailable.
      }
    }
  }
  let citationMetadata: Awaited<ReturnType<typeof lookupCrossref>> | undefined;
  if (!arxivMetadata && (paper.doi || paper.title)) {
    try {
      citationMetadata = await lookupCrossref({ title: paper.title, doi: paper.doi });
    } catch {
      // Keep local extraction when the citation database has no usable match.
    }
  }
  const metadata = arxivMetadata || citationMetadata;
  if (!extracted.authors.length && !extracted.year && !extracted.journalRef && !extracted.arxivId && !metadata) {
    skipped++;
    continue;
  }
  const refreshed = repo.update(paper.id, {
    title: paper.title,
    authors: arxivMetadata ? arxivMetadata.authors : citationMetadata?.authors.length ? citationMetadata.authors : extracted.authors.length ? extracted.authors : paper.authors,
    year: arxivMetadata ? arxivMetadata.year : citationMetadata?.year || extracted.year || paper.year,
    publishedDate: arxivMetadata ? arxivMetadata.publishedDate : citationMetadata?.publishedDate || paper.publishedDate,
    updatedDate: arxivMetadata ? arxivMetadata.updatedDate : paper.updatedDate,
    abstract: arxivMetadata ? arxivMetadata.abstract : citationMetadata?.abstract || paper.abstract,
    primaryCategory: arxivMetadata ? arxivMetadata.primaryCategory : paper.primaryCategory,
    categories: arxivMetadata ? arxivMetadata.categories : citationMetadata?.categories.length ? citationMetadata.categories : paper.categories,
    journalRef: arxivMetadata ? arxivMetadata.journalRef : citationMetadata?.journalRef || extracted.journalRef || paper.journalRef,
    acceptedVenue: arxivMetadata?.acceptedVenue || paper.acceptedVenue,
    doi: arxivMetadata ? arxivMetadata.doi : citationMetadata?.doi || paper.doi,
    arxivId: arxivMetadata ? arxivMetadata.arxivId : extracted.arxivId || paper.arxivId,
    arxivUrl: arxivMetadata ? arxivMetadata.arxivUrl : paper.arxivUrl,
    sourceUrl: paper.sourceUrl || (arxivMetadata ? arxivMetadata.sourceUrl : citationMetadata?.sourceUrl),
    tags: paper.tags,
    metadataSource: arxivMetadata ? "arxiv" : "mixed",
  });
  updated++;
  console.log(`${refreshed.title} — ${refreshed.authors.join(", ") || "authors not found"} — ${refreshed.year || "year not found"} — ${refreshed.journalRef || "venue not found"}`);
}

db.close();
console.log(`Metadata backfill complete: ${updated} updated, ${skipped} skipped.`);
