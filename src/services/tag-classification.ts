import { fetchWithTimeout, readResponseJson } from "./http.js";
import type { PaperRecord } from "../types.js";

export type ClassificationSettings = { model: string; threshold: number };
export type ClassificationTag = { id: string; name: string };
export type ClassificationDecision = { tagId: string; name: string; probability: number };

export const DEFAULT_CLASSIFICATION_SETTINGS: ClassificationSettings = {
  model: "~typesafe/jev-latest",
  // A conservative starting point only. Users should tune this on labeled papers.
  threshold: 0.9,
};

const TAGS_PER_REQUEST = 40;
const MAX_METADATA_CHARS = 12000;

type NoulQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
type DecisionsRequest = { model: string; state: Record<string, unknown>; questions: Record<string, NoulQuestion> };
type NoulAnswer = { type: "noul"; noul: number };
type DecisionsResponse = { answers: Record<string, unknown> };

function bounded(value: string | undefined, maximum: number): string | undefined {
  const clean = value?.trim();
  return clean ? clean.slice(0, maximum) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateAnswer(answer: unknown): number {
  if (!isRecord(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error("DECISIONS_RESPONSE_INVALID");
  }
  return answer.noul;
}

async function requestDecisions(fetcher: typeof fetch, apiKey: string, request: DecisionsRequest): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(fetcher, "https://openrouter.ai/api/alpha/decisions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "PersonalPaperLibrary" },
    body: JSON.stringify(request),
  }, 30_000);
  if (!response.ok) throw new Error(response.status === 429 ? "OPENROUTER_RATE_LIMITED" : `OPENROUTER_HTTP_${response.status}`);
  const body = await readResponseJson<unknown>(response, 10_000);
  if (!isRecord(body) || !isRecord(body.answers)) throw new Error("DECISIONS_RESPONSE_INVALID");
  return body.answers;
}

export async function classifyPaperTags(input: {
  fetcher: typeof fetch;
  apiKey: string;
  settings: ClassificationSettings;
  paper: PaperRecord;
  tags: ClassificationTag[];
  savedSummary?: string;
}): Promise<ClassificationDecision[]> {
  const candidates = input.tags.filter((tag) => tag.id && tag.name && tag.name.toLocaleLowerCase() !== "no pdf");
  const decisions: ClassificationDecision[] = [];
  for (let start = 0; start < candidates.length; start += TAGS_PER_REQUEST) {
    const chunk = candidates.slice(start, start + TAGS_PER_REQUEST);
    const questionToTag = new Map<string, ClassificationTag>();
    const questions: Record<string, NoulQuestion> = {};
    chunk.forEach((tag, index) => {
      const key = `tag_${index}`;
      questionToTag.set(key, tag);
      questions[key] = {
        type: "noul",
        instructions: `Does this paper fit the existing library tag named ${JSON.stringify(tag.name)}? Judge topical relevance from the paper metadata and available summary. A tag applies only when it is a meaningful subject, method, or research-area label for this paper.`,
        criteria: {
          true: "The paper substantially studies, uses, or contributes to this topic, method, or research area.",
          false: "The connection is incidental, unsupported by the metadata, or the paper does not fit this tag.",
        },
      };
    });
    const summary = bounded(input.savedSummary, 2000);
    const state = {
      paper: {
        title: bounded(input.paper.title, 1000),
        authors: input.paper.authors.slice(0, 30).map((author) => author.slice(0, 200)),
        abstract: bounded(input.paper.abstract, 6000),
        categories: input.paper.categories.slice(0, 30).map((category) => category.slice(0, 200)),
        primary_category: bounded(input.paper.primaryCategory, 200),
        year: input.paper.year,
        doi: bounded(input.paper.doi, 200),
        arxiv_id: bounded(input.paper.arxivId, 200),
        saved_summary: summary,
      },
      candidate_tag_names: chunk.map((tag) => tag.name),
    };
    if (JSON.stringify(state).length > MAX_METADATA_CHARS) throw new Error("CLASSIFICATION_METADATA_TOO_LARGE");
    const answers = await requestDecisions(input.fetcher, input.apiKey, { model: input.settings.model, state, questions });
    const expectedKeys = new Set(questionToTag.keys());
    for (const key of Object.keys(answers)) if (!expectedKeys.has(key)) throw new Error("DECISIONS_RESPONSE_INVALID");
    for (const [key, tag] of questionToTag) {
      const probability = validateAnswer(answers[key]);
      if (probability >= input.settings.threshold) decisions.push({ tagId: tag.id, name: tag.name, probability });
    }
  }
  return decisions;
}
