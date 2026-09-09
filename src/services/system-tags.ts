export const NO_PDF_TAG = "no pdf";

/** Keep the PDF status tag derived from storage, not from editable user input. */
export function tagsForPdfStatus(tags: string[] | undefined, hasPdf: boolean): string[] {
  const customTags = [...new Set((tags || []).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))]
    .filter((tag) => tag !== NO_PDF_TAG);
  if (hasPdf) return customTags.slice(0, 50);
  return [...customTags.slice(0, 49), NO_PDF_TAG];
}
