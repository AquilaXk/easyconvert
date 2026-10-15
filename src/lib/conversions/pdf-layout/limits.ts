import { ConversionFailedError } from '../../types';

/** Deepest recursion the column analysis follows (a column inside a column and so on). */
export const PDF_LAYOUT_MAX_DEPTH = 8;
/** Elementary steps (comparisons, cell assignments) the layout of one page may take before it is refused. */
export const PDF_LAYOUT_MAX_STEPS_PER_PAGE = 60_000_000;
/** Cells a detected table grid may have; a larger grid is not treated as a table. */
export const PDF_LAYOUT_MAX_TABLE_CELLS = 20_000;
/** Distinct grid lines per axis a ruled table may have. */
export const PDF_LAYOUT_MAX_GRID_LINES = 400;

/** A page whose layout analysis would take more steps than the limit allows; HTTP 400. */
export class PdfLayoutLimitError extends ConversionFailedError {
  readonly status = 400;
  constructor(pageNumber: number) {
    super(`PDF page ${pageNumber} is too complex to analyze: its layout needs more than ${PDF_LAYOUT_MAX_STEPS_PER_PAGE} steps.`);
    this.name = 'PdfLayoutLimitError';
  }
}

/** Counts the steps of one page's layout and throws when the page costs more than the limit. */
export class LayoutBudget {
  private steps = 0;

  constructor(private readonly pageNumber: number) {}

  /** Charges `count` steps. */
  tick(count = 1): void {
    this.steps += count;
    if (this.steps > PDF_LAYOUT_MAX_STEPS_PER_PAGE) throw new PdfLayoutLimitError(this.pageNumber);
  }
}
