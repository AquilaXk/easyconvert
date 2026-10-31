/** The bounds of the in-process PDF table writer, kept apart from it so a bounds table can read them without loading the writer. */

/** Cells (rows times columns, over all sheets) one PDF document may hold before it is refused with HTTP 413: the most the in-process table writer draws. */
export const PDF_TABLE_MAX_CELLS = 1_000_000;
/** Columns one sheet of a PDF table may hold. */
export const PDF_TABLE_MAX_COLUMNS = 16_384;
