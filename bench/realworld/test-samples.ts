/**
 * The files a test may name as a sample: those of the real-world corpus and those of the regression corpus. A file is in
 * exactly one of them (tests/regression-corpus-manifest-real.test.ts), so an id finds one file whichever manifest holds it.
 */
import fs from 'node:fs';
import { MANIFEST_PATH, type CorpusFile } from './manifest';
import { readRegressionManifest } from './regression/manifest';

export function readTestSampleFiles(): CorpusFile[] {
  const realWorld = (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { files: CorpusFile[] }).files;
  return [...realWorld, ...readRegressionManifest().files];
}
