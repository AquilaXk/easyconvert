import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for LibreOffice that answers every `--convert-to pdf` with a prepared PDF. It is for routes whose
 * LibreOffice step cannot run on the host (the build has no import filter for the source format, as with
 * Keynote): the test then checks what the worker does with LibreOffice's PDF, not LibreOffice's own rendering.
 */

const SHIM_MODE = 0o755;

export async function withSofficeShim<T>(pdf: Buffer, run: () => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-shim-'));
  const previous = process.env.SOFFICE_PATH;
  try {
    const pdfPath = path.join(dir, 'prepared.pdf');
    fs.writeFileSync(pdfPath, pdf);
    const shim = path.join(dir, 'soffice');
    fs.writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'while [ "$#" -gt 1 ]; do',
        '  if [ "$1" = "--outdir" ]; then outdir="$2"; fi',
        '  shift',
        'done',
        'name=$(basename "$1")',
        `cp '${pdfPath}' "$outdir/\${name%.*}.pdf"`,
        '',
      ].join('\n'),
      { mode: SHIM_MODE }
    );
    process.env.SOFFICE_PATH = shim;
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SOFFICE_PATH;
    else process.env.SOFFICE_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
