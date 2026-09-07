import type { LlmClient } from "./llm.js";
import type { LibrarySearchHit } from "../repositories/library-search.js";
import type { SummaryRecord } from "../repositories/analysis.js";

export type LibraryGroup = { name: string; description: string; paperIds: string[]; evidence: string };

function parseJson(value: string): unknown {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || value;
  return JSON.parse(fenced.trim());
}

export async function groupLibraryResults(hits: LibrarySearchHit[], query: string, client: LlmClient, model: string, getSummary: (paperId: string) => SummaryRecord | null): Promise<LibraryGroup[]> {
  const source = hits.slice(0, 20).map((hit) => {
    const summary = getSummary(hit.paper.id);
    return JSON.stringify({
      paperId: hit.paper.id,
      title: hit.paper.title,
      authors: hit.paper.authors,
      abstract: hit.paper.abstract?.slice(0, 1800) || "",
      summary: summary?.status === "complete" ? summary.content.slice(0, 2400) : "",
      evidence: hit.evidence,
    });
  }).join("\n");
  const response = await client.complete({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "Group retrieved academic papers into useful themes. Use only the supplied papers. Return valid JSON with exactly one top-level key, groups. Never invent paper IDs or facts. Only propose themes that are meaningful and relevant to the user's query." },
      { role: "user", content: `The user's library query is:\n${query}\n\nCreate at most five thematic groups from these retrieved papers. A group needs at least one paper and must be meaningful and directly relevant to the user's query. Do not propose a theme merely because papers share a broad field or a superficial keyword. For every group, explain in evidence why the papers form a coherent theme and why that theme helps answer the user's query. If a possible group is not clearly relevant to the query, leave it out. Give each group a short name, a concise description, the supplied paper IDs, and substantive evidence. Use only IDs supplied below. If no meaningful, query-relevant grouping is possible, return an empty groups array. Return exactly this shape: {"groups":[{"name":"...","description":"...","paperIds":["..."],"evidence":"Why this theme is coherent and relevant to the query..."}]}\n\nRetrieved papers:\n${source}` },
    ],
  });
  const parsed = parseJson(response) as { groups?: unknown };
  if (!parsed || !Array.isArray(parsed.groups)) throw new Error("LIBRARY_GROUPING_INVALID");
  const allowed = new Set(hits.map((hit) => hit.paper.id));
  const groups: LibraryGroup[] = [];
  for (const item of parsed.groups.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const group = item as Record<string, unknown>;
    const name = typeof group.name === "string" ? group.name.trim().slice(0, 120) : "";
    const description = typeof group.description === "string" ? group.description.trim().slice(0, 500) : "";
    const evidence = typeof group.evidence === "string" ? group.evidence.trim().slice(0, 700) : "";
    const paperIds = Array.isArray(group.paperIds) ? [...new Set(group.paperIds.filter((id): id is string => typeof id === "string" && allowed.has(id)))] : [];
    if (name && description && evidence && paperIds.length) groups.push({ name, description, paperIds, evidence });
  }
  return groups;
}
