export type LibraryStatistics = {
  totalPapers: number;
  withPdf: number;
  withoutPdf: number;
  withAbstract: number;
  withoutAbstract: number;
  withSummary: number;
  withoutSummary: number;
  staleSummaries: number;
  failedSummaries: number;
  withAnswers: number;
  withoutAnswers: number;
  answeredQuestions: number;
  staleAnswers: number;
  failedAnswers: number;
  fullyEnriched: number;
  needsPdf: number;
  needsAbstract: number;
  needsSummary: number;
  needsAnswers: number;
  aiFailures: number;
};

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
    staleSummaries: numberValue("stale_summaries"),
    failedSummaries,
    withAnswers,
    withoutAnswers: Math.max(0, totalPapers - withAnswers),
    answeredQuestions: numberValue("answered_questions"),
    staleAnswers: numberValue("stale_answers"),
    failedAnswers,
    fullyEnriched: numberValue("fully_enriched"),
    needsPdf: Math.max(0, totalPapers - withPdf),
    needsAbstract: Math.max(0, totalPapers - withAbstract),
    needsSummary: numberValue("needs_summary"),
    needsAnswers: numberValue("needs_answers"),
    aiFailures: failedSummaries + failedAnswers,
  };
}

