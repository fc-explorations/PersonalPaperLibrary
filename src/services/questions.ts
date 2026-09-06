import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type QuestionDefinition = { id: string; groupId: string; groupTitle: string; groupDescription: string; label: string; prompt: string; order: number; definitionHash: string; isCustom?: boolean };
type QuestionRow = Record<string, string>;

function scalar(value: string): string {
  const clean = value.trim();
  if (clean.startsWith("\"") && clean.endsWith("\"")) {
    try { return JSON.parse(clean); } catch { return clean.slice(1, -1); }
  }
  if (clean.startsWith("'") && clean.endsWith("'")) return clean.slice(1, -1).replace(/''/g, "'");
  return clean;
}

/** Parse the intentionally small, readable YAML shape used by config/questions.yaml. */
function parseQuestionsYaml(source: string): QuestionRow[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const rows: QuestionRow[] = [];
  let current: QuestionRow | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith("#") || line.trim() === "questions:") continue;
    const listItem = line.match(/^\s*-\s+id:\s*(.*)$/);
    if (listItem) { current = { id: scalar(listItem[1]) }; rows.push(current); continue; }
    const field = line.match(/^\s{4}([a-z_]+):\s*(.*)$/);
    if (!field || !current) continue;
    const [, name, rawValue] = field;
    if (rawValue === ">" || rawValue === "|") {
      const block: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        if (/^\s{4}\S/.test(next) || /^\s*-\s+id:/.test(next)) break;
        index += 1;
        block.push(next.trim());
      }
      current[name] = rawValue === ">" ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trim();
    } else current[name] = scalar(rawValue);
  }
  return rows;
}

function readCatalog(): QuestionRow[] {
  const configuredPath = process.env.QUESTION_BANK_PATH || "config/questions.yaml";
  try {
    const workingPath = resolve(process.cwd(), configuredPath);
    const runtimePath = fileURLToPath(new URL(`../../config/questions.yaml`, import.meta.url));
    try { return parseQuestionsYaml(readFileSync(workingPath, "utf8")); }
    catch { return parseQuestionsYaml(readFileSync(runtimePath, "utf8")); }
  }
  catch (error) { throw new Error(`QUESTION_BANK_UNAVAILABLE: ${error instanceof Error ? error.message : "unable to read YAML catalog"}`); }
}

export function questionDefinitions(): QuestionDefinition[] {
  return readCatalog().map((row, index) => {
    const id = row.id?.trim();
    const groupId = row.group_id?.trim();
    const groupTitle = row.group?.trim();
    const groupDescription = row.group_description?.trim();
    const label = row.label?.trim();
    const prompt = row.prompt?.trim();
    if (!id || !groupId || !groupTitle || !label || !prompt) throw new Error(`QUESTION_BANK_INVALID: incomplete question at entry ${index + 1}`);
    const definitionHash = createHash("sha256").update(JSON.stringify({ id, groupId, groupTitle, groupDescription, label, prompt })).digest("hex");
    return { id, groupId, groupTitle, groupDescription: groupDescription || "", label, prompt, order: index, definitionHash, isCustom: false };
  });
}
