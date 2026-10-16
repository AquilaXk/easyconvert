import fs from 'node:fs';
import type { WorkerVfsPayload } from './worker-types';

/**
 * The format an Adobe Illustrator file is converted as. Files saved with PDF compatibility (the default since version CS)
 * are PDFs with private data and take the PDF path; versions 3 to 8 are PostScript programs, which the signature check has
 * accepted for their Illustrator prolog, and take the PostScript path.
 */

const PDF_FORMAT = 'pdf';
const POSTSCRIPT_FORMAT = 'ps';
const POSTSCRIPT_SIGNATURE = Buffer.from('%!PS');

/** The first `bytes` bytes of the input. */
function readInputHead(input: Buffer | WorkerVfsPayload, bytes: number): Buffer {
  if (Buffer.isBuffer(input)) return input.subarray(0, bytes);
  if (input.inputBuffer) return input.inputBuffer.subarray(0, bytes);
  if (!input.inputPath) return Buffer.alloc(0);
  const fd = fs.openSync(input.inputPath, 'r');
  try {
    const head = Buffer.alloc(bytes);
    return head.subarray(0, fs.readSync(fd, head, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}

export function illustratorRouteFormat(input: Buffer | WorkerVfsPayload): string {
  return readInputHead(input, POSTSCRIPT_SIGNATURE.length).equals(POSTSCRIPT_SIGNATURE) ? POSTSCRIPT_FORMAT : PDF_FORMAT;
}
