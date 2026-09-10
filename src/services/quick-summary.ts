import type { LlmClient } from "./llm.js";

function cleanQuickSummary(value: string, maxParagraphs: number): string {
  return value
    .replace(/^\s*```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/^#{1,6}\s+[^\n]+$/gm, "")
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, "")
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, maxParagraphs)
    .join("\n\n");
}

export function compactQuickSummary(value: string, maxParagraphs: 1 | 2): string {
  return cleanQuickSummary(value, maxParagraphs);
}

export async function generateQuickSummary(client: LlmClient, model: string, value: string, maxParagraphs: 1 | 2): Promise<string> {
  const source = value.trim().slice(0, 24_000);
  if (!source) return "";
  const paragraphInstruction = maxParagraphs === 1 ? "exactly one concise paragraph" : "one or two concise paragraphs";
  const response = await client.complete({
    model,
    temperature: 0.2,
    maxOutputTokens: 700,
    messages: [
      { role: "system", content: "You write concise, factual summaries of scientific analysis. Use only the supplied text and do not invent details." },
      { role: "user", content: `Write ${paragraphInstruction} that gives the quickest useful understanding of the supplied text. Preserve important claims, conclusions, limitations, and uncertainty. Return only prose, with no heading, bullets, preamble, or commentary.\n\nText to condense:\n${source}` },
    ],
  });
  return cleanQuickSummary(response, maxParagraphs);
}
