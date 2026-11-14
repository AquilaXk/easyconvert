import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every place that reads what a sandboxed program wrote goes through src/lib/security/sandbox-output.ts, which opens without following a
 * link. This lists them: a file here that stops importing the module has gone back to a read that follows a link. The files that read
 * their program's output by their own descriptor with O_NOFOLLOW (avif-cli.ts, website-capture.ts) are checked for that flag instead.
 */

const ROOT = path.resolve(__dirname, '..');
const READERS = [
  'src/lib/conversions/archive.ts',
  'src/lib/conversions/cad-dwg.ts',
  'src/lib/conversions/cad-occt.ts',
  'src/lib/conversions/font-fontforge.ts',
  'src/lib/conversions/media-empty-output.ts',
  'src/lib/conversions/media.ts',
  'src/lib/conversions/midi-render.ts',
  'src/lib/conversions/ocr-cli.ts',
  'src/lib/conversions/pdf-page-render.ts',
  'src/lib/conversions/pdf-postprocess/compress.ts',
  'src/lib/conversions/pdf-postprocess/page-ops.ts',
  'src/lib/conversions/pdf-postprocess/pdfa.ts',
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
const NOFOLLOW_READERS = ['src/lib/conversions/avif-cli.ts', 'src/lib/capture/website-capture.ts'];

const source = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

describe('the readers of the output of a sandboxed program', () => {
  it.each(READERS)('%s reads through sandbox-output', (file) => {
    expect(source(file)).toMatch(/from '(?:\.\.\/)+(?:lib\/)?security\/sandbox-output'/);
  });

  it.each(NOFOLLOW_READERS)('%s opens the output with O_NOFOLLOW', (file) => {
    expect(source(file)).toMatch(/O_NOFOLLOW/);
  });
});
