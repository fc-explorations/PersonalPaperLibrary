import { describe, expect, it } from "vitest";
import { lookupOpenLibrary } from "../src/services/openlibrary.js";
import { isbnFromInput, normalizeIsbn } from "../src/services/validation.js";

describe("ISBN and Open Library lookup", () => {
  it("normalizes valid ISBNs and rejects invalid checksums", () => {
    expect(normalizeIsbn("978-0-262-38136-9")).toBe("9780262381369");
    expect(isbnFromInput("ISBN: 0262381362")).toBe("0262381362");
    expect(() => normalizeIsbn("9780262381368")).toThrow("INVALID_ISBN");
  });

  it("maps an exact Open Library ISBN result into paper metadata", async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://openlibrary.org");
      expect(url.pathname).toBe("/search.json");
      expect(url.searchParams.get("isbn")).toBe("9780262381369");
      return new Response(JSON.stringify({ docs: [{
        title: "Learning Theory from First Principles",
        author_name: ["Francis Bach"],
        first_publish_year: 2024,
        publisher: ["MIT Press"],
      }] }), { status: 200 });
    };

    await expect(lookupOpenLibrary("978-0-262-38136-9", fetcher)).resolves.toMatchObject({
      title: "Learning Theory from First Principles",
      authors: ["Francis Bach"],
      year: 2024,
      isbn: "9780262381369",
      sourceUrl: "https://openlibrary.org/isbn/9780262381369",
    });
  });

  it("reports a missing Open Library match", async () => {
    const fetcher = async () => new Response(JSON.stringify({ docs: [] }), { status: 200 });
    await expect(lookupOpenLibrary("9780262381369", fetcher)).rejects.toThrow("OPENLIBRARY_NO_MATCH");
  });
});
