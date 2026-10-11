import fs from 'node:fs';
import path from 'node:path';
import { CORPUS_DIR, REPO_ROOT } from './config';
import { sha256Hex } from './ref-cache';

/**
 * Hashes that tie a cached reference measurement to the code that took it: the measuring helpers every family uses
 * and the family's own runner. Editing a metric or a reference command line therefore starts a fresh cache.
 */

const SHARED_HARNESS_FILES = [
  'bench/measure.ts',
  'bench/rows.ts',
  'bench/text-metrics.ts',
  'bench/tools.ts',
  'tests/helpers/ffmpeg-measure.ts',
  'tests/helpers/ocr-cer.ts',
];

/** Files a family's runner shares with its other runners or with a helper process, which a cached measurement also depends on. */
const FAMILY_HARNESS_FILES: Readonly<Record<string, readonly string[]>> = {
  compression: ['bench/families/compression-fixture.ts'],
  data: ['bench/reference-server.ts', 'bench/reference-server.py'],
  font: ['bench/reference-server.ts', 'bench/reference-server.py'],
};

/** SHA-256 over the shared harness files, `bench/families/<family>.ts` and the family's own helper files, in a fixed order. */
export function harnessHash(family: string, root: string = REPO_ROOT): string {
  const files = [...SHARED_HARNESS_FILES, `bench/families/${family}.ts`, ...(FAMILY_HARNESS_FILES[family] ?? [])];
  const parts = files.map((file) => `${file}\n${sha256Hex(fs.readFileSync(path.join(root, file)))}`);
  return sha256Hex(parts.join('\n'));
}

/** SHA-256 of a corpus file by its path relative to the corpus directory. */
export function corpusFileHash(relative: string, corpusDir: string = CORPUS_DIR): string {
  const resolved = path.resolve(corpusDir, relative);
  if (!resolved.startsWith(`${path.resolve(corpusDir)}${path.sep}`)) throw new RangeError(`corpus path escapes the corpus directory: ${relative}`);
  return sha256Hex(fs.readFileSync(resolved));
}
