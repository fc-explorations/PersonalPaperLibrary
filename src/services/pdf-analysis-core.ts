export const SUMMARY_PROMPT_VERSION = "summary-v3";
export const QUESTION_PROMPT_VERSION = "question-v2";
export const SUMMARY_HEADINGS = ["Problem", "Core Idea", "Method", "Experimental Setup", "Main Findings", "Limitations", "Why It Matters"] as const;

const APPENDIX_HEADING = /^(?:appendix|appendices|supplementary\s+(?:material|appendix)|supplemental\s+(?:material|appendix)|supporting\s+(?:information|material))(?:\s+[A-Z0-9]+)?(?:\s*[:.\-]\s*.*)?$/i;

export function excludeAppendixMaterial(text: string): { text: string; excluded: boolean } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const minimumOffset = Math.max(2_000, Math.floor(text.length * 0.15));
  let offset = 0;
  for (const line of lines) {
    const heading = line.replace(/\f/g, " ").trim();
    if (offset >= minimumOffset && heading.length <= 180 && APPENDIX_HEADING.test(heading)) {
      const mainText = text.slice(0, offset).trim();
      return mainText ? { text: mainText, excluded: true } : { text, excluded: false };
    }
    offset += line.length + 1;
  }
  return { text, excluded: false };
}

export function splitTextIntoChunks(text: string, maxCharacters = 20_000, overlap = 500): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = current.slice(Math.max(0, current.length - overlap));
  };
  for (const paragraph of paragraphs) {
    if (paragraph.length > maxCharacters) {
      if (current) pushCurrent();
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(paragraph.length, start + maxCharacters);
        chunks.push(paragraph.slice(start, end));
        start = end === paragraph.length ? end : end - overlap;
      }
      current = "";
      continue;
    }
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxCharacters && current) pushCurrent();
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitTextIntoPageChunks(text: string, pagesPerChunk = 4): string[] {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const pages = normalized.split("\f").map((page) => page.trim()).filter(Boolean);
  if (pages.length <= 1) return splitTextIntoChunks(normalized);
  const chunks: string[] = [];
  for (let index = 0; index < pages.length; index += pagesPerChunk) chunks.push(pages.slice(index, index + pagesPerChunk).join("\n\n"));
  return chunks;
}

export function takeFirstPages(text: string, pageCount = 4): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized || pageCount < 1) return normalized;
  const pages = normalized.split("\f").map((page) => page.trim()).filter(Boolean);
  return pages.length <= pageCount ? normalized : pages.slice(0, pageCount).join("\n\n");
}

export function hasRequiredSummaryHeadings(content: string): boolean {
  return SUMMARY_HEADINGS.every((heading) => new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "mi").test(content));
}
