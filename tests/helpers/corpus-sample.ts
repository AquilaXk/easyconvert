import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureCached } from '../../bench/realworld/fetch';
import { readManifest } from '../../bench/realworld/manifest';
import { isStrictMode } from './strict-skip';

/** Where the nightly corpus run and the tests keep the real sample files they fetched, digest-checked. */
export const REALWORLD_CACHE_DIR = path.join(os.homedir(), '.cache', 'easyconvert-realworld');

/**
 * A real sample file of bench/realworld/manifest.json: fetched from the host that publishes it, checked against the
 * manifest's SHA-256 and cached. Offline, a developer machine gets null (the test skips it); under ORACLE_STRICT_MODE=1
 * (CI) the fetch error propagates, so the suite fails by name instead of passing without its input.
 */
export async function corpusSample(id: string): Promise<Buffer | null> {
  const entry = readManifest().files.find((file) => file.id === id);
  if (!entry) throw new Error(`${id} is not in the corpus manifest`);
  try {
    return fs.readFileSync(await ensureCached(entry, REALWORLD_CACHE_DIR));
  } catch (error) {
    if (isStrictMode()) throw error;
    return null;
  }
}
