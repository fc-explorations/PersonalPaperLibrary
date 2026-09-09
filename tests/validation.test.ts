import { describe, expect, it } from "vitest";
import { parseOptionalDate } from "../src/services/validation.js";

describe("optional date validation", () => {
  it("treats missing-date markers as absent", () => {
    expect(parseOptionalDate(null)).toBeUndefined();
    expect(parseOptionalDate("null")).toBeUndefined();
    expect(parseOptionalDate("undefined")).toBeUndefined();
    expect(parseOptionalDate("N/A")).toBeUndefined();
  });

  it("still rejects arbitrary invalid dates", () => {
    expect(() => parseOptionalDate("publication date unavailable")).toThrow("INVALID_DATE");
  });
});
