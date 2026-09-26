import { describe, expect, it } from "vitest";
import { classifyPaperTags, DEFAULT_CLASSIFICATION_SETTINGS } from "../src/services/tag-classification.js";
import type { PaperRecord } from "../src/types.js";

const paper: PaperRecord = {
  id: "paper-1",
  title: "Graph neural networks for scientific discovery",
  authors: ["A. Researcher"],
  abstract: "We study graph neural networks for scientific discovery.",
  categories: ["cs.LG"],
  metadataSource: "manual",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tags: [],
};

describe("OpenRouter tag classification", () => {
  it("validates typed answers and maps only the configured existing tag IDs", async () => {
    let sent: Record<string, unknown> | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://openrouter.ai/api/alpha/decisions");
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ answers: {
        tag_0: { type: "noul", noul: 0.94 },
        tag_1: { type: "noul", noul: 0.45 },
      } }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const decisions = await classifyPaperTags({
      fetcher,
      apiKey: "server-secret",
      settings: { ...DEFAULT_CLASSIFICATION_SETTINGS, threshold: 0.9 },
      paper,
      tags: [{ id: "tag-id-1", name: "graph learning" }, { id: "tag-id-2", name: "biology" }],
      savedSummary: "A short saved summary.",
    });

    expect(decisions).toEqual([{ tagId: "tag-id-1", name: "graph learning", probability: 0.94 }]);
    expect(sent?.model).toBe(DEFAULT_CLASSIFICATION_SETTINGS.model);
    expect(sent?.state).toMatchObject({ candidate_tag_names: ["graph learning", "biology"] });
    expect(sent?.questions).toMatchObject({ tag_0: { type: "noul" }, tag_1: { type: "noul" } });
    expect(JSON.stringify(sent)).not.toContain("server-secret");
  });

  it("fails closed when a requested typed answer is missing or malformed", async () => {
    const fetcher: typeof fetch = async () => new Response(JSON.stringify({ answers: { tag_0: { type: "noul", noul: 1.2 } } }), { status: 200 });
    await expect(classifyPaperTags({
      fetcher,
      apiKey: "server-secret",
      settings: DEFAULT_CLASSIFICATION_SETTINGS,
      paper,
      tags: [{ id: "tag-id-1", name: "graph learning" }, { id: "tag-id-2", name: "biology" }],
    })).rejects.toThrow("DECISIONS_RESPONSE_INVALID");
  });
});
