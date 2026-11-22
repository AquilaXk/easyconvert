import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place that reads what a sandboxed program wrote goes through src/lib/security/sandbox-output.ts, which opens without following a
 * link or wait for a pipe. This lists them: a file here that stops importing the module has gone back to a read that follows a link.
 * The files that open the output by their own descriptor (avif-cli.ts, image-decoder-tools.ts, website-capture.ts) import its flags.
 */

const ROOT = path.resolve(__dirname, '..');
const READERS = [
  'src/lib/capture/website-capture.ts',
  'src/lib/conversions/archive.ts',
  'src/lib/conversions/cad-dwg.ts',
  'src/lib/conversions/cad-occt.ts',
  'src/lib/conversions/avif-cli.ts',
  'src/lib/conversions/font-fontforge.ts',
  'src/lib/conversions/image-decoder-tools.ts',
  'src/lib/conversions/media-empty-output.ts',
  'src/lib/conversions/media.ts',
  'src/lib/conversions/midi-render.ts',
  'src/lib/conversions/ocr-cli.ts',
  'src/lib/conversions/pdf-page-render.ts',
  'src/lib/conversions/pdf-postprocess/compress.ts',
  'src/lib/conversions/pdf-postprocess/page-ops.ts',
  'src/lib/conversions/pdf-postprocess/pdfa.ts',
  'src/lib/conversions/pdf-postprocess/qpdf-run.ts',
  'src/lib/conversions/raster-vectorize.ts',
  'src/worker/djvu-render.ts',
  'src/worker/ebook-calibre.ts',
  'src/worker/engines.ts',
  'src/worker/libreoffice-pool.ts',
  'src/worker/pdf-decrypt.ts',
  'src/worker/pdf-ink.ts',
  'src/worker/poppler-ppm.ts',
  'src/worker/postscript-page-limit.ts',
  'src/worker/postscript-render.ts',
  'src/worker/raw-decoded-tiff.ts',
  'src/worker/subtitle-route.ts',
  'src/worker/worker-output.ts',
  'src/worker/xps-render.ts',
];

const source = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the readers of the output of a sandboxed program', () => {
  it.each(READERS)('%s reads through sandbox-output', (file) => {
    expect(source(file)).toMatch(/from '(?:\.\.\/)+(?:lib\/)?security\/sandbox-output'/);
  });
});
