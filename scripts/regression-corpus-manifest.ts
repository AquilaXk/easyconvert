/**
 * Builds bench/realworld/regression-manifest.json (issue #780, regression corpus at the scale of the document engines).
 *
 *   tsx scripts/regression-corpus-manifest.ts index   --work DIR
 *   tsx scripts/regression-corpus-manifest.ts profile --work DIR [--limit N] [--reverse] [--redo-producer REGEX]
 *   tsx scripts/regression-corpus-manifest.ts select  --work DIR
 *
 * `index` reads the central directory of every government-corpus archive and of a spread of the crawl corpus's archives, and the
 * crawl corpus's PDF metadata table (producer, script flag). `profile` draws a pool of candidates, stratified by format and size
 * class, downloads each file in memory (never to disk, never executed), and records its SHA-256, the producer named in the file
 * itself and whether it carries macros or script. `select` drops those files and draws the corpus: the budget of each group is
 * shared equally between its strata of format, producer class and size class (bench/realworld/regression/stratify.ts).
 * Every step is deterministic and `profile` resumes where it stopped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { download, mapLimit, sha256 } from '../bench/realworld/fetch';
import { fetchBytes, fetchSize, fetchStream } from '../bench/realworld/http';
import { readManifest, type CorpusManifest, type CorpusSource } from '../bench/realworld/manifest';
import { crawlArchiveUrl, CRAWL_METADATA_URL, csvRecords, govdocsArchiveUrl, pdfinfoRecords } from '../bench/realworld/regression/build';
import {
  type ArchiveIndex,
  BUDGETS,
  type Candidate,
  corpusFileOf,
  crawlCandidates,
  type CrawlMetadata,
  CRAWL_SOURCE,
  govdocsCandidates,
  GOVDOCS_SOURCE,
  type IndexEntry,
  type Profile,
  profiledCandidates,
} from '../bench/realworld/regression/candidates';
import { REGRESSION_MANIFEST_PATH, serializeRegressionManifest } from '../bench/realworld/regression/manifest';
import { hasMacros, producerOf } from '../bench/realworld/regression/producer';
import { renderCorpusStats } from '../bench/realworld/regression/stats';
import { selectStratified } from '../bench/realworld/regression/stratify';
import { EOCD_SEARCH_BYTES, locateCentralDirectory, parseCentralDirectory } from '../bench/realworld/zip-range';

const GOVDOCS_ARCHIVES = 1000;
/** Every 200th archive of the crawl corpus: file numbers there follow the hash order of the PDFs, so any archive is a random sample of the crawl. */
const CRAWL_ARCHIVE_STEP = 200;
const CRAWL_ARCHIVES = 7933;
const CRAWL_ZIP_DIGITS = 4;
const POOL_FACTOR = 1.5;
const DOWNLOAD_CONCURRENCY = 12;
const INDEX_CONCURRENCY = 12;
const DIRECTORY_CAP_BYTES = 16 * 1024 * 1024;
const PROGRESS_EVERY = 250;

const SOURCES: CorpusSource[] = [
  {
    id: GOVDOCS_SOURCE,
    description: 'Documents collected from public web servers in the .gov domain (the digital corpora research corpus), 1,000 archives of 1,000 files each, read by byte range.',
    licence: "Published as freely redistributable to the best of the publisher's knowledge. Not committed here: fetched at run time by digest for internal conversion testing, and deleted after each file is judged.",
  },
  {
    id: CRAWL_SOURCE,
    description: 'PDF files from the CC-MAIN-2021-31 web crawl, re-fetched untruncated and packaged by the digital corpora project (SafeDocs program), read by byte range.',
    licence: 'Files collected by Common Crawl from public web servers: Common Crawl terms of use and the digital corpora terms apply. Not committed, redistributed, shown or shipped here: fetched at run time by digest for internal conversion testing, and deleted after each file is judged.',
  },
];

class ArgumentError extends Error {}

const jsonPath = (work: string, name: string): string => path.join(work, name);
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

async function archiveIndex(archive: string): Promise<IndexEntry[]> {
  const size = await fetchSize(archive);
  const directory = locateCentralDirectory(await fetchBytes(archive, [Math.max(0, size - EOCD_SEARCH_BYTES), size - 1], EOCD_SEARCH_BYTES));
  const entries = parseCentralDirectory(await fetchBytes(archive, [directory.offset, directory.offset + directory.size - 1], DIRECTORY_CAP_BYTES), directory.entries);
  return entries.map((e) => [e.name, e.localHeaderOffset, e.compressedSize, e.method, e.size]);
}

async function indexArchives(urls: ReadonlyMap<string, string>): Promise<Record<string, IndexEntry[]>> {
  const out: Record<string, IndexEntry[]> = {};
  let done = 0;
  await mapLimit([...urls.entries()], INDEX_CONCURRENCY, async ([key, url]) => {
    out[key] = await archiveIndex(url);
    if (++done % 100 === 0) console.log(`indexed ${done}/${urls.size} archives`);
  });
  return out;
}

async function crawlMetadata(zips: ReadonlySet<string>): Promise<CrawlMetadata> {
  const stream = Readable.fromWeb((await fetchStream(CRAWL_METADATA_URL)) as never).pipe(createGunzip());
  stream.setEncoding('utf8');
  const out: Record<string, { producer: string | null; script: boolean }> = {};
  let header: string[] | null = null;
  let rows = 0;
  for await (const record of csvRecords(stream as AsyncIterable<string>)) {
    if (header === null) {
      header = record;
      continue;
    }
    rows++;
    if (!zips.has(record[header.indexOf('file_name')].slice(0, CRAWL_ZIP_DIGITS))) continue;
    const [entry] = pdfinfoRecords([header, record]);
    out[entry.fileName] = { producer: entry.producer, script: entry.script };
  }
  console.log(`read ${rows} rows of the crawl metadata table, kept ${Object.keys(out).length}`);
  return out;
}

async function runIndex(work: string): Promise<void> {
  fs.mkdirSync(work, { recursive: true });
  const crawlNumbers = Array.from({ length: Math.ceil(CRAWL_ARCHIVES / CRAWL_ARCHIVE_STEP) }, (_, i) => i * CRAWL_ARCHIVE_STEP).filter((n) => n < CRAWL_ARCHIVES);
  const govdocs = new Map(Array.from({ length: GOVDOCS_ARCHIVES }, (_, n) => [String(n).padStart(3, '0'), govdocsArchiveUrl(n)]));
  const crawl = new Map(crawlNumbers.map((n) => [String(n).padStart(CRAWL_ZIP_DIGITS, '0'), crawlArchiveUrl(n)]));
  fs.writeFileSync(jsonPath(work, 'govdocs-index.json'), JSON.stringify(await indexArchives(govdocs)));
  fs.writeFileSync(jsonPath(work, 'crawl-index.json'), JSON.stringify(await indexArchives(crawl)));
  fs.writeFileSync(jsonPath(work, 'crawl-metadata.json'), JSON.stringify(await crawlMetadata(new Set(crawl.keys()))));
}

/** `archive entry` keys of the zip entries the real-world corpus already holds: the regression corpus adds files, not copies. */
function takenEntries(): Set<string> {
  return new Set(readManifest().files.flatMap((file) => (file.origin.kind === 'zip' ? [`${file.origin.archive} ${file.origin.entry}`] : [])));
}

function allCandidates(work: string): Candidate[] {
  return [
    ...govdocsCandidates(readJson<ArchiveIndex>(jsonPath(work, 'govdocs-index.json')), takenEntries()),
    ...crawlCandidates(readJson<ArchiveIndex>(jsonPath(work, 'crawl-index.json')), readJson<CrawlMetadata>(jsonPath(work, 'crawl-metadata.json'))),
  ];
}

const readProfiles = (file: string): Profile[] => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Profile) : []);

async function profileOne(candidate: Candidate): Promise<Profile | null> {
  try {
    const bytes = await download(corpusFileOf(candidate, '0'.repeat(64), null));
    return { id: candidate.id, sha256: sha256(bytes), size: bytes.length, producer: producerOf(candidate.format, bytes) ?? candidate.hint, excluded: hasMacros(candidate.format, bytes) };
  } catch (error) {
    console.warn(`skip ${candidate.id}: ${String(error)}`);
    return null;
  }
}

async function runProfile(work: string, limit: number | undefined, reverse: boolean, redo: RegExp | null): Promise<void> {
  const poolBudgets = Object.fromEntries(Object.entries(BUDGETS).map(([group, budget]) => [group, Math.ceil(budget * POOL_FACTOR)]));
  const pool = selectStratified(allCandidates(work), poolBudgets);
  const file = jsonPath(work, 'profile.jsonl');
  // A profile whose producer matches `redo` was read by an older reader; it is profiled again and the later line wins.
  const done = new Set(readProfiles(file).filter((profile) => redo === null || !redo.test(profile.producer ?? '')).map((profile) => profile.id));
  const pending = pool.filter((candidate) => !done.has(candidate.id));
  const todo = (reverse ? pending.reverse() : pending).slice(0, limit);
  console.log(`pool ${pool.length}, profiled ${done.size}, to do ${todo.length}`);
  let count = 0;
  await mapLimit(todo, DOWNLOAD_CONCURRENCY, async (candidate) => {
    const profile = await profileOne(candidate);
    if (profile !== null) fs.appendFileSync(file, `${JSON.stringify(profile)}\n`);
    if (++count % PROGRESS_EVERY === 0) console.log(`profiled ${count}/${todo.length}`);
  });
}

function runSelect(work: string): void {
  const profiles = new Map(readProfiles(jsonPath(work, 'profile.jsonl')).map((profile) => [profile.id, profile]));
  const chosen = selectStratified(profiledCandidates(allCandidates(work), profiles), BUDGETS);
  const manifest: CorpusManifest = { schema: 1, sources: SOURCES, files: chosen.map((candidate) => corpusFileOf(candidate, candidate.profile.sha256, candidate.profile.producer)) };
  fs.writeFileSync(REGRESSION_MANIFEST_PATH, serializeRegressionManifest(manifest));
  console.log(`wrote ${manifest.files.length} files to ${REGRESSION_MANIFEST_PATH}`);
  console.log(renderCorpusStats(manifest.files));
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  if (args[at + 1] === undefined) throw new ArgumentError(`${name} needs a value`);
  return args[at + 1];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const work = flag(rest, '--work') ?? path.join(os.tmpdir(), 'regression-corpus-build');
  const limit = flag(rest, '--limit');
  const redoPattern = flag(rest, '--redo-producer');
  if (command === 'index') await runIndex(work);
  else if (command === 'profile') await runProfile(work, limit === undefined ? undefined : Number(limit), rest.includes('--reverse'), redoPattern === undefined ? null : new RegExp(redoPattern));
  else if (command === 'select') runSelect(work);
  else throw new ArgumentError('usage: index|profile|select --work DIR');
}

main().catch((error: unknown) => {
  console.error(`regression-corpus-manifest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ArgumentError ? 2 : 1);
});
