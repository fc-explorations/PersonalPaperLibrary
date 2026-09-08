import type { PaperMetadata } from "../types.js";
import { fetchWithTimeout, readResponseJson } from "./http.js";
import { normalizeIsbn } from "./validation.js";

interface OpenLibraryBook {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  publish_date?: string[];
  publisher?: string[];
  isbn?: string[];
  key?: string;
}

function yearFromBook(book: OpenLibraryBook): number | undefined {
  if (Number.isInteger(book.first_publish_year)) return book.first_publish_year;
  const year = book.publish_date?.map((value) => value.match(/\b(1[5-9]\d{2}|20\d{2})\b/)?.[1]).find(Boolean);
  return year ? Number(year) : undefined;
}

function mapBook(book: OpenLibraryBook, isbn: string): PaperMetadata {
  const year = yearFromBook(book);
  const sourceUrl = `https://openlibrary.org/isbn/${isbn}`;
  return {
    title: book.title?.trim() || "Untitled book",
    authors: (book.author_name || []).map((author) => author.trim()).filter(Boolean),
    year,
    publishedDate: year ? String(year) : undefined,
    categories: [],
    journalRef: book.publisher?.filter(Boolean).join(", ") || undefined,
    isbn,
    sourceUrl,
    metadataSource: "mixed",
  };
}

export async function lookupOpenLibrary(isbnInput: string, fetcher: typeof fetch = fetch): Promise<PaperMetadata> {
  const isbn = normalizeIsbn(isbnInput);
  if (!isbn) throw new Error("ISBN_REQUIRED");
  const url = new URL("https://openlibrary.org/search.json");
  url.searchParams.set("isbn", isbn);
  url.searchParams.set("limit", "1");
  url.searchParams.set("fields", "title,author_name,first_publish_year,publish_date,publisher,isbn,key");
  const response = await fetchWithTimeout(fetcher, url, { headers: { "User-Agent": "PersonalPaperLibrary/1.0" } });
  if (!response.ok) throw new Error(`OPENLIBRARY_HTTP_${response.status}`);
  const payload = await readResponseJson<{ docs?: OpenLibraryBook[] }>(response);
  const book = payload.docs?.[0];
  if (!book) throw new Error("OPENLIBRARY_NO_MATCH");
  return mapBook(book, isbn);
}
