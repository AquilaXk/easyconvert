import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A stand-in for the PostScript interpreter. It records the option flags it was started with and writes a
 * prepared PDF to the output path (its last argument), so a test can check the worker's route (the flags, the
 * hand-over of the PDF to Poppler and the encoders) without Ghostscript. The interpreter's own rendering is
 * checked in the tests that run the real binary.
 */

const SHIM_MODE = 0o755;

async function withShimEnvironment<T>(script: (dir: string) => string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps2pdf-shim-'));
  const previous = process.env.PS2PDF_PATH;
  try {
    const shim = path.join(dir, 'ps2pdf');
    fs.writeFileSync(shim, script(dir), { mode: SHIM_MODE });
    process.env.PS2PDF_PATH = shim;
    return await run(dir);
  } finally {
    if (previous === undefined) delete process.env.PS2PDF_PATH;
    else process.env.PS2PDF_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `run` with an interpreter that answers every file with `pdf`; `flags()` lists the options it was given. */
export async function withPs2pdfShim<T>(pdf: Buffer, run: (flags: () => string[]) => Promise<T>): Promise<T> {
  return withShimEnvironment(
    (dir) => {
      const pdfPath = path.join(dir, 'prepared.pdf');
      fs.writeFileSync(pdfPath, pdf);
      const flagsLog = path.join(dir, 'flags.log');
      return [
        '#!/bin/sh',
        'for argument; do',
        '  case "$argument" in',
        `    -*) printf '%s\\n' "$argument" >> '${flagsLog}' ;;`,
        '  esac',
        '  last="$argument"',
        'done',
        `cp '${pdfPath}' "$last"`,
        '',
      ].join('\n');
    },
    (dir) => run(() => (fs.existsSync(path.join(dir, 'flags.log')) ? fs.readFileSync(path.join(dir, 'flags.log'), 'utf-8').trim().split('\n') : []))
  );
}

/** Runs `run` with an interpreter that rejects every file the way Ghostscript does for a syntax error. */
export async function withRejectingPs2pdf<T>(stderr: string, run: () => Promise<T>): Promise<T> {
  return withShimEnvironment(() => `#!/bin/sh\necho "${stderr}" >&2\nexit 1\n`, () => run());
}
