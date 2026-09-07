import { describe, expect, it } from "vitest";
import { suggestTags } from "../src/services/tag-suggestions.js";

describe("tag suggestions", () => {
  it("preserves matching library tags and normalizes duplicate casing", async () => {
    const client = {
      complete: async () => JSON.stringify({ suggestions: [
        { name: "Machine Learning", reason: "The abstract studies a learned model." },
        { name: "machine learning", reason: "Duplicate variant." },
        { name: "Bayesian inference", reason: "The abstract describes posterior uncertainty." },
      ] }),
    };

    await expect(suggestTags({ abstract: "A paper about learned models.", existingTags: ["Machine Learning"] }, client, "gpt-5-nano")).resolves.toEqual([
      { name: "Machine Learning", existing: true, reason: "The abstract studies a learned model." },
      { name: "Bayesian inference", existing: false, reason: "The abstract describes posterior uncertainty." },
    ]);
  });
});
