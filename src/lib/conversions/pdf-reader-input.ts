import { fontProgramToUnicodeObjects } from './pdf-font-tounicode';
import { withIncrementalUpdate } from './pdf-incremental-update';
import { InlinePictureCollector, planPictureDecoding } from './pdf-picture-guard';
import { assertPdfAnnotationStreamsWithinLimits, assertPdfStreamsWithinLimits } from './pdf-stream-guard';
import { pdfTextFailure } from './pdf-text-types';

/** What a text job reads of the document: its content, and the pictures of that content. */
export interface PdfReaderInputJob {
  content: boolean;
  pictures: boolean;
}

/**
 * The bytes the text thread hands to pdf.js. The streams the text depends on are decoded under byte budgets first, since pdf.js
 * would inflate a bomb to its end; every job reads the annotations of its pages, so one that does not want the content still
 * has their streams checked. A job for the content then gets one incremental update that gives the fonts that need one a
 * ToUnicode map (pdf-font-tounicode.ts) and, when it writes pictures, replaces by null every picture past a decoding limit
 * (pdf-picture-guard.ts).
 * @throws the errors of `assertPdfStreamsWithinLimits` and `planPictureDecoding`, and PayloadLimitError (413) for a picture past
 * a limit in a file that names no cross-reference to update.
 */
export function pdfjsReadableBytes(bytes: Buffer, job: PdfReaderInputJob): Buffer {
  if (!job.content) {
    assertPdfAnnotationStreamsWithinLimits(bytes);
    return bytes;
  }
  const inline = job.pictures ? new InlinePictureCollector() : null;
  const document = assertPdfStreamsWithinLimits(bytes, inline?.visit);
  const dropped = inline === null ? [] : planPictureDecoding(document, inline).dropped;
  const base = document.updateBase();
  if (base === null) {
    if (dropped.length > 0) {
      throw pdfTextFailure('limit', `PDF picture of object ${dropped[0].num} is past a decoding limit, and the file names no cross-reference that a reader could take its replacement from.`);
    }
    return bytes;
  }
  const nulls = dropped.map(({ num, gen }) => ({ num, gen, body: 'null' }));
  return withIncrementalUpdate(bytes, base, [...fontProgramToUnicodeObjects(document, base), ...nulls]);
}
