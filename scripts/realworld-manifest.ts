/**
 * Builds bench/realworld/manifest.json. Deterministic: archives and file lists are walked in order and files are taken
 * per format until each quota is met, skipping empty files and files over the size cap. Every chosen file is
 * downloaded once to record its SHA-256.
 *
 *   tsx scripts/realworld-manifest.ts --govdocs 0-19 --office-list FILE --office-commit SHA
 *
 * `--office-list` is the output of `git ls-tree -r --name-only <SHA> test-data/document test-data/spreadsheet
 * test-data/slideshow` in a clone of the office-format test data repository.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getFormatByExtension } from '../src/lib/registry';
import { download, mapLimit, MAX_CORPUS_FILE_BYTES, sha256 } from '../bench/realworld/fetch';
import { fetchBytes, fetchSize } from '../bench/realworld/http';
import { MANIFEST_PATH, MANIFEST_SCHEMA, parseManifest, type CorpusFile, type CorpusManifest, type CorpusSource } from '../bench/realworld/manifest';
import { EOCD_SEARCH_BYTES, locateCentralDirectory, parseCentralDirectory } from '../bench/realworld/zip-range';

const GOVDOCS_BASE = 'https://digitalcorpora.s3.amazonaws.com/corpora/files/govdocs1/zipfiles';
const OFFICE_BASE = 'https://raw.githubusercontent.com/apache/poi';
const ARCHIVE_NAME_DIGITS = 3;
/** Files above this size are left out: they dominate fetch and run time without adding parser coverage. */
const SIZE_CAP_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_CONCURRENCY = 8;
const DIRECTORY_CAP_BYTES = 16 * 1024 * 1024;

const SOURCES: CorpusSource[] = [
  {
    id: 'govdocs1',
    description: 'Documents and images collected from public web servers in the .gov domain, published as a research corpus.',
    licence: 'Published as freely redistributable to the best of the publisher\'s knowledge; not committed here, fetched for testing only.',
  },
  {
    id: 'office-test-data',
    description: 'Office documents, spreadsheets and presentations from the test data of an Apache-licensed office-format library.',
    licence: 'Apache License 2.0 (distributed with the library\'s source release); not committed here, fetched for testing only.',
  },
];

/** Files per source format taken from the government document corpus. */
const GOVDOCS_QUOTA: Readonly<Record<string, number>> = {
  pdf: 1200, html: 450, txt: 250, doc: 600, xls: 400, ppt: 400, jpg: 450, gif: 150, ps: 80, xml: 80, csv: 80, rtf: 40, png: 30,
};
/** Formats taken from the office test data (all eligible files). */
const OFFICE_FORMATS: ReadonlySet<string> = new Set(['doc', 'docx', 'dotx', 'xls', 'xlsx', 'xlsm', 'xlsb', 'ppt', 'pptx']);

interface Candidate {
  source: string;
  id: string;
  format: string;
  origin: CorpusFile['origin'];
  size: number;
}

class ArgumentError extends Error {}

function formatOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot === -1) return null;
  return getFormatByExtension(name.slice(dot + 1).toLowerCase())?.id ?? null;
}

const safeId = (text: string): string => text.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+/, '');

async function govdocsCandidates(first: number, last: number): Promise<Candidate[]> {
  const taken = new Map<string, number>();
  const out: Candidate[] = [];
  for (let n = first; n <= last; n++) {
    const archive = `${GOVDOCS_BASE}/${String(n).padStart(ARCHIVE_NAME_DIGITS, '0')}.zip`;
    const size = await fetchSize(archive);
    const tailStart = Math.max(0, size - EOCD_SEARCH_BYTES);
    const directory = locateCentralDirectory(await fetchBytes(archive, [tailStart, size - 1], EOCD_SEARCH_BYTES));
    const entries = parseCentralDirectory(await fetchBytes(archive, [directory.offset, directory.offset + directory.size - 1], DIRECTORY_CAP_BYTES), directory.entries);
    for (const entry of entries) {
      const format = formatOf(entry.name);
      if (format === null || entry.size === 0 || entry.size > SIZE_CAP_BYTES) continue;
      const quota = GOVDOCS_QUOTA[format] ?? 0;
      if ((taken.get(format) ?? 0) >= quota) continue;
      taken.set(format, (taken.get(format) ?? 0) + 1);
      const origin = { kind: 'zip' as const, archive, entry: entry.name, offset: entry.localHeaderOffset, compressedSize: entry.compressedSize, method: entry.method };
      out.push({ source: 'govdocs1', id: `govdocs1-${safeId(path.basename(entry.name))}`, format, origin, size: entry.size });
    }
    console.log(`govdocs1 ${n}: ${out.length} candidates`);
  }
  return out;
}

function officeCandidates(listFile: string, commit: string): Candidate[] {
  const out: Candidate[] = [];
  for (const line of fs.readFileSync(listFile, 'utf8').split('\n')) {
    const name = line.trim();
    const format = formatOf(name);
    if (name === '' || format === null || !OFFICE_FORMATS.has(format)) continue;
    const url = `${OFFICE_BASE}/${commit}/${name.split('/').map(encodeURIComponent).join('/')}`;
    out.push({ source: 'office-test-data', id: `office-${safeId(name.replace(/^test-data\//, '').replace(/\//g, '-'))}`, format, origin: { kind: 'file', url }, size: 0 });
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const at = args.indexOf(name);
    if (at === -1 || args[at + 1] === undefined) throw new ArgumentError(`${name} is required`);
    return args[at + 1];
  };
  const range = /^(\d+)-(\d+)$/.exec(value('--govdocs'));
  if (range === null) throw new ArgumentError('--govdocs must look like 0-19');
  const commit = value('--office-commit');
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new ArgumentError('--office-commit must be a full commit SHA');

  const candidates = [...(await govdocsCandidates(Number(range[1]), Number(range[2]))), ...officeCandidates(value('--office-list'), commit)];
  let downloaded = 0;
  const files = await mapLimit(candidates, DOWNLOAD_CONCURRENCY, async (candidate): Promise<CorpusFile | null> => {
    const probe: CorpusFile = { id: candidate.id, source: candidate.source, origin: candidate.origin, format: candidate.format, size: candidate.size || 1, sha256: '0'.repeat(64) };
    const bytes = await download(candidate.size === 0 ? { ...probe, size: MAX_CORPUS_FILE_BYTES } : probe).catch((error: unknown) => {
      console.warn(`skip ${candidate.id}: ${String(error)}`);
      return null;
    });
    if (++downloaded % 200 === 0) console.log(`hashed ${downloaded}/${candidates.length}`);
    if (bytes === null || bytes.length === 0 || bytes.length > SIZE_CAP_BYTES) return null;
    return { ...probe, size: bytes.length, sha256: sha256(bytes) };
  });
  const unique = new Map<string, CorpusFile>();
  for (const file of files) if (file !== null && !unique.has(file.id)) unique.set(file.id, file);
  const manifest: CorpusManifest = { schema: MANIFEST_SCHEMA, sources: SOURCES, files: [...unique.values()] };
  parseManifest(JSON.stringify(manifest));
  // One file per line keeps the manifest compact and its diffs readable.
  const body = [
    '{',
    `"schema": ${manifest.schema},`,
    `"sources": ${JSON.stringify(manifest.sources)},`,
    '"files": [',
    manifest.files.map((file) => JSON.stringify(file)).join(',\n'),
    ']',
    '}',
  ].join('\n');
  fs.writeFileSync(MANIFEST_PATH, `${body}\n`);
  console.log(`wrote ${manifest.files.length} files to ${MANIFEST_PATH}`);
}

main().catch((error: unknown) => {
  console.error(`realworld-manifest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(error instanceof ArgumentError ? 2 : 1);
});
