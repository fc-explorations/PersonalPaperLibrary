export type MetadataSource = "arxiv" | "manual" | "mixed";

export interface PaperMetadata {
  arxivId?: string;
  arxivBaseId?: string;
  title: string;
  abstract?: string;
  authors: string[];
  publishedDate?: string;
  updatedDate?: string;
  year?: number;
  primaryCategory?: string;
  categories: string[];
  journalRef?: string;
  acceptedVenue?: string;
  doi?: string;
  isbn?: string;
  sourceUrl?: string;
  /** A downloadable PDF URL used transiently during metadata lookup. */
  pdfUrl?: string;
  arxivUrl?: string;
  /** Tags suggested or derived during a lookup; not present on provider responses. */
  tags?: string[];
  metadataSource: MetadataSource;
}

export interface PaperRecord extends PaperMetadata {
  id: string;
  r2Key?: string;
  pdfSha256?: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
}

export interface PaperDraftInput {
  id?: string;
  arxivId?: string;
  title: string;
  abstract?: string;
  authors?: string[];
  publishedDate?: string;
  updatedDate?: string;
  year?: number | string;
  primaryCategory?: string;
  categories?: string[];
  journalRef?: string;
  acceptedVenue?: string;
  doi?: string;
  isbn?: string;
  sourceUrl?: string;
  arxivUrl?: string;
  metadataSource?: MetadataSource;
  tags?: string[];
  stagingToken?: string;
}

export type SortOrder = "newest" | "oldest" | "year-desc" | "year-asc" | "title";
