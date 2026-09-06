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
  doi?: string;
  sourceUrl?: string;
  arxivUrl?: string;
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
  doi?: string;
  sourceUrl?: string;
  arxivUrl?: string;
  metadataSource?: MetadataSource;
  tags?: string[];
  stagingToken?: string;
}

export type SortOrder = "newest" | "oldest" | "year-desc" | "year-asc" | "title";
