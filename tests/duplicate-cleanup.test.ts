import { describe, expect, it } from "vitest";
import type { PaperRecord } from "../src/types.js";
import { deduplicatePapers } from "../src/services/duplicate-cleanup.js";

function paper(id: string, overrides: Partial<PaperRecord> = {}): PaperRecord {
  return {
    id,
    title: "A shared paper title",
    authors: [],
    categories: [],
    metadataSource: "manual",
    createdAt: `2026-09-0${id === "old" ? "1" : "2"}T00:00:00.000Z`,
    updatedAt: "2026-09-02T00:00:00.000Z",
    tags: [],
    ...overrides,
  };
}

describe("duplicate cleanup", () => {
  it("keeps the most complete paper and removes the weaker entries", () => {
    const result = deduplicatePapers([
      paper("incomplete"),
      paper("complete", { abstract: "An abstract.", authors: ["Ada Lovelace"], year: 2024, doi: "10.1000/example", r2Key: "papers/complete.pdf" }),
    ], {
      summaries: new Map([[
        "complete",
        { paperId: "complete", content: "A current summary.", provider: "test", model: "test", generatedAt: "2026-09-02T00:00:00.000Z", promptVersion: "test", status: "complete" },
      ]]),
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ keep: { id: "complete" }, remove: [{ id: "incomplete" }] });
    expect(result.removeIds).toEqual(["incomplete"]);
  });

  it("keeps the oldest paper when duplicate records are equally complete", () => {
    const result = deduplicatePapers([paper("new", { createdAt: "2026-09-02T00:00:00.000Z" }), paper("old", { createdAt: "2026-09-01T00:00:00.000Z" })]);

    expect(result.groups[0]).toMatchObject({ keep: { id: "old" }, remove: [{ id: "new" }] });
  });
});
