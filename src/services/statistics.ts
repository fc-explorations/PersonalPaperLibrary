export type LibraryStatistics = {
  totalPapers: number;
  withPdf: number;
  withoutPdf: number;
  withAbstract: number;
  withoutAbstract: number;
  withSummary: number;
  withoutSummary: number;
  withAuthors: number;
  withYear: number;
  withIdentifier: number;
  metadataComplete: number;
  withoutMetadata: number;
  staleSummaries: number;
  failedSummaries: number;
  withAnswers: number;
  withoutAnswers: number;
  answeredQuestions: number;
  staleAnswers: number;
  failedAnswers: number;
  fullyEnriched: number;
  untaggedPapers: number;
  totalTags: number;
  duplicateCandidates: number;
  recentPapers: number;
  neverAnalyzed: number;
  indexedPapers: number;
  pendingIndex: number;
  failedIndex: number;
  unavailableIndex: number;
  queuedJobs: number;
  runningJobs: number;
  failedJobs: number;
  needsPdf: number;
  needsAbstract: number;
  needsSummary: number;
  needsAnswers: number;
  aiFailures: number;
};

export type AttentionFilter = "missing-pdf" | "missing-abstract" | "missing-summary" | "missing-answer" | "missing-metadata" | "duplicate-candidate" | "never-analyzed" | "recent" | "stale-summary" | "stale-answer" | "ai-failure";

const attentionFilterValues: AttentionFilter[] = ["missing-pdf", "missing-abstract", "missing-summary", "missing-answer", "missing-metadata", "duplicate-candidate", "never-analyzed", "recent", "stale-summary", "stale-answer", "ai-failure"];

export function parseAttentionFilter(value: unknown): AttentionFilter | undefined {
  return typeof value === "string" && attentionFilterValues.includes(value as AttentionFilter) ? value as AttentionFilter : undefined;
}

export function libraryStatisticsFromRow(row: Record<string, unknown>): LibraryStatistics {
  const numberValue = (key: string): number => {
    const value = Number(row[key] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const totalPapers = numberValue("total_papers");
  const withPdf = numberValue("with_pdf");
  const withAbstract = numberValue("with_abstract");
  const withSummary = numberValue("with_summary");
  const withAnswers = numberValue("with_answers");
  const metadataComplete = numberValue("metadata_complete");
  const failedSummaries = numberValue("failed_summaries");
  const failedAnswers = numberValue("failed_answers");

  return {
    totalPapers,
    withPdf,
    withoutPdf: Math.max(0, totalPapers - withPdf),
    withAbstract,
    withoutAbstract: Math.max(0, totalPapers - withAbstract),
    withSummary,
    withoutSummary: Math.max(0, totalPapers - withSummary),
    withAuthors: numberValue("with_authors"),
    withYear: numberValue("with_year"),
    withIdentifier: numberValue("with_identifier"),
    metadataComplete,
    withoutMetadata: Math.max(0, totalPapers - metadataComplete),
    staleSummaries: numberValue("stale_summaries"),
    failedSummaries,
    withAnswers,
    withoutAnswers: Math.max(0, totalPapers - withAnswers),
    answeredQuestions: numberValue("answered_questions"),
    staleAnswers: numberValue("stale_answers"),
    failedAnswers,
    fullyEnriched: numberValue("fully_enriched"),
    untaggedPapers: numberValue("untagged_papers"),
    totalTags: numberValue("total_tags"),
    duplicateCandidates: numberValue("duplicate_candidates"),
    recentPapers: numberValue("recent_papers"),
    neverAnalyzed: numberValue("never_analyzed"),
    indexedPapers: numberValue("indexed_papers"),
    pendingIndex: numberValue("pending_index"),
    failedIndex: numberValue("failed_index"),
    unavailableIndex: numberValue("unavailable_index"),
    queuedJobs: numberValue("queued_jobs"),
    runningJobs: numberValue("running_jobs"),
    failedJobs: numberValue("failed_jobs"),
    needsPdf: Math.max(0, totalPapers - withPdf),
    needsAbstract: Math.max(0, totalPapers - withAbstract),
    needsSummary: numberValue("needs_summary"),
    needsAnswers: numberValue("needs_answers"),
    aiFailures: failedSummaries + failedAnswers,
  };
}
