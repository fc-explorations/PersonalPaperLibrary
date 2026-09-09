import type { LlmClient } from "./llm.js";
import type { LibrarySearchHit } from "../repositories/library-search.js";
import type { SummaryRecord } from "../repositories/analysis.js";

export type LibraryGroup = { name: string; description: string; paperIds: string[]; evidence: string };

function operatorAt(value: string, index: number, operator: "AND" | "OR"): boolean {
  return value.slice(index, index + operator.length).toLocaleUpperCase() === operator
    && (index === 0 || !/[A-Za-z0-9_]/.test(value[index - 1] || ""))
    && (index + operator.length === value.length || !/[A-Za-z0-9_]/.test(value[index + operator.length] || ""));
}

function splitBoolean(value: string, operator: "AND" | "OR"): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && operatorAt(value, index, operator)) {
      parts.push(value.slice(start, index).trim());
      start = index + operator.length;
      index += operator.length - 1;
    }
  }
  if (depth !== 0) return undefined;
  parts.push(value.slice(start).trim());
  return parts.some((part) => !part) ? undefined : parts;
}

function stripOuterParentheses(value: string): string {
  let result = value.trim();
  while (result.startsWith("(") && result.endsWith(")")) {
    let depth = 0;
    let enclosesAll = true;
    let quoted = false;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === '"') quoted = !quoted;
      if (quoted) continue;
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (depth === 0 && index < result.length - 1) { enclosesAll = false; break; }
    }
    if (!enclosesAll || depth !== 0) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function cleanBooleanTerm(value: string): string {
  return value.trim().replace(/^"|"$/g, "").replace(/\s+/g, " ");
}

function naturalizeBooleanQuery(value: string): string | undefined {
  const expression = stripOuterParentheses(value);
  const andGroups = splitBoolean(expression, "AND");
  if (!andGroups || andGroups.length < 2) return undefined;
  const groups = andGroups.map((group) => {
    const alternatives = splitBoolean(stripOuterParentheses(group), "OR");
    return (alternatives || [stripOuterParentheses(group)]).map(cleanBooleanTerm).filter(Boolean);
  });
  if (groups.some((group) => !group.length) || !groups.some((group) => group.length > 1)) return undefined;
  const renderedGroups = groups.map((group) => group.length === 1 ? group[0] : `${group.slice(0, -1).join(", ")}, or ${group[group.length - 1]}`);
  return `Find papers relating to all of these topic groups: ${renderedGroups.join("; ")}.`;
}

export async function rephraseLibraryQuery(query: string, client: LlmClient, model: string): Promise<string> {
  const response = await client.complete({
    model,
    temperature: 0.2,
    messages: [
      { role: "system", content: "Rewrite academic library search requests into one concise natural-language query optimized for semantic retrieval. Capture the user's intent, key concepts, entities, methods, populations, outcomes, and constraints without inventing facts. If the input uses Boolean or database-search syntax, translate it into ordinary language: express alternatives with phrases such as 'including' or 'such as', express required concepts with natural wording, and preserve exclusions with 'without' or 'excluding'. Return only one plain-text sentence or search phrase. Do not use Boolean operators as syntax, parentheses, brackets, field prefixes, or a list of quoted synonyms. Do not answer the request or explain the rewrite. Keep the result under 1,000 characters." },
      { role: "user", content: query },
    ],
  });
  const rewritten = response.trim()
    .replace(/^(?:rephrased|rewritten)\s+(?:query|search)\s*:\s*/i, "")
    .replace(/^`|`$/g, "")
    .trim();
  if (!rewritten) throw new Error("LIBRARY_REPHRASE_EMPTY");
  return (naturalizeBooleanQuery(rewritten) || rewritten).slice(0, 1000);
}

function parseJson(value: string): unknown {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1] || value;
  return JSON.parse(fenced.trim());
}

export async function groupLibraryResults(hits: LibrarySearchHit[], query: string, client: LlmClient, model: string, getSummary: (paperId: string) => SummaryRecord | null | Promise<SummaryRecord | null>): Promise<LibraryGroup[]> {
  const source = (await Promise.all(hits.slice(0, 20).map(async (hit) => {
    const summary = await getSummary(hit.paper.id);
    return JSON.stringify({
      paperId: hit.paper.id,
      title: hit.paper.title,
      authors: hit.paper.authors,
      abstract: hit.paper.abstract?.slice(0, 1800) || "",
      summary: summary?.status === "complete" ? summary.content.slice(0, 2400) : "",
      evidence: hit.evidence,
    });
  }))).join("\n");
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
