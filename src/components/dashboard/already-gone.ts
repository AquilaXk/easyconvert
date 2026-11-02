const HTTP_NOT_FOUND = 404;

/**
 * Whether a refused delete is a 404, which means the record is already gone: the person's goal is met, so the page says so
 * with `sentence` and drops the row instead of keeping it beside an error.
 */
export function settleAlreadyGone(
  status: number,
  sentence: string,
  onReportError: (error: string | null) => void,
  dropRow: () => void
): boolean {
  if (status !== HTTP_NOT_FOUND) return false;
  onReportError(sentence);
  dropRow();
  return true;
}
