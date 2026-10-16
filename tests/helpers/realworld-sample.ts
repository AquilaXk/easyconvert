import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ensureCached } from '../../bench/realworld/fetch';
import { MANIFEST_PATH, type CorpusFile } from '../../bench/realworld/manifest';
import { isStrictMode } from './strict-skip';

/**
 * The real files of the real-world corpus (bench/realworld/manifest.json) that a test converts. They are never
 * committed: `ensureCached` fetches a file from the host that publishes it and checks it against the digest the manifest
 * pins, so a test reads the same bytes everywhere. Where a file cannot be fetched a run that is not strict skips the
 * test; under ORACLE_STRICT_MODE=1 it fails, so CI cannot pass without having read the file.
 */

const CACHE_DIRECTORY = process.env.REALWORLD_CACHE ?? path.join(os.homedir(), '.cache', 'easyconvert-realworld');

let corpusFiles: Map<string, CorpusFile> | undefined;

function corpusFile(id: string): CorpusFile {
  corpusFiles ??= new Map((JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { files: CorpusFile[] }).files.map((file) => [file.id, file]));
  const found = corpusFiles.get(id);
  if (found === undefined) throw new Error(`no real-world sample ${id} in the corpus manifest`);
  return found;
}

/** What the test context offers: `skip` ends the test as skipped. */
interface SkippableContext {
  skip: () => never;
}

/** Path of the cached sample `id` and its bytes; see the module comment for what a missing file does. */
export async function requireRealworldSample(ctx: SkippableContext, id: string): Promise<{ bytes: Buffer; path: string; format: string }> {
  const file = corpusFile(id);
  try {
    const cached = await ensureCached(file, CACHE_DIRECTORY);
    return { bytes: fs.readFileSync(cached), path: cached, format: file.format };
  } catch (error) {
    if (isStrictMode()) throw error;
    return ctx.skip();
  }
}
