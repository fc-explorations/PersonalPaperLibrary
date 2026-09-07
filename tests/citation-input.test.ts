import { describe, expect, it } from "vitest";
import { citationMatchesMetadata, parseCitationInput } from "../src/services/citation-input.js";

describe("citation input parsing", () => {
  it("isolates a title and authors with the deterministic fallback", async () => {
    const parsed = await parseCitationInput("Noe, F., Olsson, S., Köhler, J., and Wu, H. Boltzmann Generators: Sampling equilibrium states of many-body systems (2024)");

    expect(parsed.usedLlm).toBe(false);
    expect(parsed.title).toBe("Boltzmann Generators: Sampling equilibrium states of many-body systems");
    expect(parsed.authors).toContain("Noe");
    expect(parsed.year).toBe(2024);
  });

  it("uses the selected LLM when a citation is complex", async () => {
    let selectedModel = "";
    const parsed = await parseCitationInput(
      "Noe, F., Olsson, S., Köhler, J., and Wu, H. Boltzmann Generators: Sampling equilibrium states of many-body systems. Nature Physics, 2024.",
      {
        complete: async (input) => {
          selectedModel = input.model;
          return '{"title":"Boltzmann Generators: Sampling equilibrium states of many-body systems","authors":["Frank Noé","S. Olsson","J. Köhler","H. Wu"],"year":2024,"venue":"Nature Physics"}';
        },
      },
      "gpt-5-nano",
    );

    expect(selectedModel).toBe("gpt-5-nano");
    expect(parsed.usedLlm).toBe(true);
    expect(parsed.title).toBe("Boltzmann Generators: Sampling equilibrium states of many-body systems");
    expect(parsed.venue).toBe("Nature Physics");
  });

  it("falls back when the LLM is unavailable and rejects mismatched metadata", async () => {
    const parsed = await parseCitationInput("Smith, J. A useful paper about models (2023)", {
      complete: async () => { throw new Error("provider unavailable"); },
    }, "gemma4:12b");

    expect(parsed.usedLlm).toBe(false);
    expect(citationMatchesMetadata(parsed, { authors: ["Jane Smith"], year: 2023 })).toBe(true);
    expect(citationMatchesMetadata(parsed, { authors: ["Jane Smith"], year: 2020 })).toBe(false);
  });
});
