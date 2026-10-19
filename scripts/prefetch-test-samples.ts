/**
 * Fetches every real-world corpus file that the tests name into the corpus cache before the run, so no test waits on a
 * download inside its own timeout. The files are found, not listed: a manifest id that occurs as a quoted string in a
 * file under tests/ is a sample some test reads. Under ORACLE_STRICT_MODE=1 (CI) a file that cannot be fetched fails the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureCached, findCached, mapLimit, testSampleCacheDirectory } from '../bench/realworld/fetch';
import { MANIFEST_PATH, type CorpusFile } from '../bench/realworld/manifest';

const TESTS_DIRECTORY = path.resolve(__dirname, '..', 'tests');
const FETCH_CONCURRENCY = 6;
const QUOTED_STRING = /(['"`])((?:(?!\1)[^\\\n])+)\1/g;

function* testFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* testFiles(entryPath);
    else if (entry.name.endsWith('.ts')) yield entryPath;
  }
}

/** The manifest ids that occur as a quoted string literal in a `.ts` file under `testsDirectory`, in manifest order. */
export function findTestSampleIds(manifestIds: readonly string[], testsDirectory: string): string[] {
  const known = new Set(manifestIds);
  const named = new Set<string>();
  for (const file of testFiles(testsDirectory)) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(QUOTED_STRING)) {
      if (known.has(match[2])) named.add(match[2]);
    }
  }
  return manifestIds.filter((id) => named.has(id));
}

async function main(): Promise<number> {
  const files = (JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as { files: CorpusFile[] }).files;
  const byId = new Map(files.map((file) => [file.id, file]));
  const ids = findTestSampleIds(files.map((file) => file.id), TESTS_DIRECTORY);
  const cacheDirectory = testSampleCacheDirectory();
  const failures: string[] = [];
  let alreadyCached = 0;
  await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
    const file = byId.get(id) as CorpusFile;
    if (findCached(file, cacheDirectory) !== undefined) {
      alreadyCached += 1;
      return;
    }
    try {
      await ensureCached(file, cacheDirectory);
    } catch (error) {
      failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const fetched = ids.length - alreadyCached - failures.length;
  console.log(`prefetch-test-samples: ${ids.length} samples named by tests, ${alreadyCached} already cached, ${fetched} fetched, ${failures.length} failed (${cacheDirectory})`);
  for (const failure of failures) console.error(`  ${failure}`);
  return failures.length > 0 && process.env.ORACLE_STRICT_MODE === '1' ? 1 : 0;
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
