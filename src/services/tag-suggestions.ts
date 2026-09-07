import type { LlmClient } from "./llm.js";

export type TagSuggestion = {
  name: string;
  existing: boolean;
  reason: string;
};

type TagSuggestionInput = {
  title?: string;
  abstract: string;
  categories?: string[];
  existingTags: string[];
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseJson(value: string): { suggestions?: unknown } | null {
  const cleaned = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidate = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
  try {
    const parsed = JSON.parse(candidate) as { suggestions?: unknown };
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function tagKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export async function suggestTags(input: TagSuggestionInput, client: LlmClient, model: string): Promise<TagSuggestion[]> {
  const existingTags = input.existingTags.map(tagKey).filter(Boolean);
  const existingByKey = new Map(existingTags.map((tag) => [tagKey(tag), tag]));
  const response = await client.complete({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are a research librarian who recommends concise, reusable paper tags. Return JSON only." },
      { role: "user", content: `Suggest tags for this paper using its abstract. Prefer the existing library tags when they genuinely fit, and propose a small number of specific new tags only when they add useful coverage.

Return exactly this JSON shape: {"suggestions":[{"name":"tag name","reason":"brief reason"}]}

Rules:
- Return at most 8 suggestions total.
- Use an existing tag exactly as written when it fits; do not invent a variant of an existing tag.
- Suggest at most 3 new tags, each concise (one to three words), specific, and reusable.
- Do not suggest generic tags such as "paper", "research", "science", "academic", or "method".
- Every suggestion must be supported by the title, abstract, or categories.
- Do not duplicate tags or include # symbols.

Existing library tags:
        ${existingTags.length ? existingTags.join(", ") : "(none)"}

Title: ${clean(input.title) || "(not provided)"}
Categories: ${input.categories?.length ? input.categories.join(", ") : "(none)"}
Abstract:
${input.abstract.trim()}` },
    ],
  });
  const parsed = parseJson(response);
  const rawSuggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const seen = new Set<string>();
  const suggestions: TagSuggestion[] = [];
  for (const raw of rawSuggestions) {
    const item = typeof raw === "string" ? { name: raw, reason: "" } : raw && typeof raw === "object" ? raw as { name?: unknown; reason?: unknown } : null;
    const requestedName = clean(item?.name).replace(/^#+/, "");
    if (!requestedName) continue;
    const key = tagKey(requestedName);
    if (seen.has(key)) continue;
    const existingName = existingByKey.get(key);
    seen.add(key);
    suggestions.push({ name: (existingName || requestedName).toLocaleLowerCase().slice(0, 100), existing: Boolean(existingName), reason: clean(item?.reason).slice(0, 180) });
    if (suggestions.length >= 8) break;
  }
  return suggestions;
}
