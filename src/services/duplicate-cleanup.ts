import type { PaperRecord } from "../types.js";
import type { StoredQuestion, SummaryRecord } from "../repositories/analysis.js";

export type DuplicateCleanupData = {
  summaries?: ReadonlyMap<string, SummaryRecord | null | undefined>;
  questions?: ReadonlyMap<string, readonly StoredQuestion[] | undefined>;
};

export type DuplicateGroup = {
  keep: PaperRecord;
  remove: PaperRecord[];
};

export type DuplicateCleanupResult = {
  groups: DuplicateGroup[];
  removeIds: string[];
};

function matchKeys(paper: PaperRecord): string[] {
  const keys: string[] = [];
  const title = paper.title.trim().toLocaleLowerCase();
  const doi = paper.doi?.trim().toLocaleLowerCase();
  const arxivId = paper.arxivId?.trim().toLocaleLowerCase();
  if (title) keys.push(`title:${title}`);
  if (doi) keys.push(`doi:${doi}`);
  if (arxivId) keys.push(`arxiv:${arxivId}`);
  return keys;
}

function hasCurrentSummary(paper: PaperRecord, data: DuplicateCleanupData): boolean {
  const summary = data.summaries?.get(paper.id);
  return summary?.status === "complete" && Boolean(summary.content.trim());
}

function hasCurrentAnswer(paper: PaperRecord, data: DuplicateCleanupData): boolean {
  return Boolean(data.questions?.get(paper.id)?.some((question) => question.answer?.status === "complete" && Boolean(question.answer.content.trim())));
}

function completenessScore(paper: PaperRecord, data: DuplicateCleanupData): number {
  const hasPdf = Boolean(paper.r2Key?.trim() || paper.pdfSha256?.trim());
  const hasAbstract = Boolean(paper.abstract?.trim());
  const hasAuthors = paper.authors.some((author) => author.trim());
  const hasIdentifier = Boolean(paper.doi?.trim() || paper.arxivId?.trim() || paper.isbn?.trim() || paper.sourceUrl?.trim());
  return (hasPdf ? 8 : 0)
    + (hasAbstract ? 4 : 0)
    + (hasCurrentSummary(paper, data) ? 3 : 0)
    + (hasCurrentAnswer(paper, data) ? 2 : 0)
    + (hasAuthors ? 2 : 0)
    + (paper.year ? 1 : 0)
    + (hasIdentifier ? 1 : 0)
    + (paper.bibtex?.trim() ? 1 : 0)
    + (paper.tags.length ? 1 : 0)
    + (paper.categories.length ? 1 : 0);
}

function oldestFirst(left: PaperRecord, right: PaperRecord): number {
  const created = left.createdAt.localeCompare(right.createdAt);
  return created || left.id.localeCompare(right.id);
}

export function deduplicatePapers(papers: PaperRecord[], data: DuplicateCleanupData = {}): DuplicateCleanupResult {
  const parent = papers.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const firstByKey = new Map<string, number>();
  papers.forEach((paper, index) => {
    for (const key of matchKeys(paper)) {
      const first = firstByKey.get(key);
      if (first === undefined) firstByKey.set(key, index);
      else union(first, index);
    }
  });

  const grouped = new Map<number, PaperRecord[]>();
  papers.forEach((paper, index) => {
    const root = find(index);
    const group = grouped.get(root) || [];
    group.push(paper);
    grouped.set(root, group);
  });

  const groups = [...grouped.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const ranked = [...group].sort((left, right) => completenessScore(right, data) - completenessScore(left, data) || oldestFirst(left, right));
      return { keep: ranked[0], remove: ranked.slice(1) };
    });
  return { groups, removeIds: groups.flatMap((group) => group.remove.map((paper) => paper.id)) };
}
