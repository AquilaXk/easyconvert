/**
 * The regression corpus manifest (bench/realworld/regression-manifest.json): about 20,000 office and PDF files, each read out of a
 * ZIP archive of the public corpora with range requests, pinned by size and SHA-256. The files are never committed. The file
 * holds one row per line in the column order of `REGRESSION_COLUMNS`, with the archive list written once, so the manifest stays
 * small and a change to it reads as a diff of rows. Reading it yields the same `CorpusManifest` the real-world runner uses, so the
 * fetcher, the plan and the pool are shared.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type CorpusFile, type CorpusManifest, type CorpusSource, MANIFEST_SCHEMA, ManifestError, parseManifest } from '../manifest';

export const REGRESSION_MANIFEST_PATH = path.join(__dirname, '..', 'regression-manifest.json');
export const REGRESSION_SCHEMA_VERSION = 1;
export const REGRESSION_COLUMNS = ['id', 'format', 'archive', 'entry', 'offset', 'compressedSize', 'method', 'size', 'sha256', 'producer'] as const;

type Row = [id: string, format: string, archive: number, entry: string, offset: number, compressedSize: number, method: number, size: number, sha256: string, producer: string];

interface ArchiveRecord {
  url: string;
  source: string;
}

interface RegressionManifestJson {
  schema: number;
  sources: CorpusSource[];
  archives: ArchiveRecord[];
  columns: string[];
  files: Row[];
}

function rowOf(file: CorpusFile, archiveIndex: Map<string, number>): Row {
  const origin = file.origin;
  if (origin.kind !== 'zip') throw new ManifestError(`${file.id}: the regression corpus reads zip archives only`);
  return [file.id, file.format, archiveIndex.get(`${file.source} ${origin.archive}`)!, origin.entry, origin.offset, origin.compressedSize, origin.method, file.size, file.sha256, file.producer ?? ''];
}

/** The manifest as text: a header, then one row per line, files sorted by id and archives numbered in the order the files first use them. */
export function serializeRegressionManifest(manifest: CorpusManifest): string {
  const files = [...manifest.files].sort((a, b) => (a.id < b.id ? -1 : 1));
  const archives = new Map<string, number>();
  for (const file of files) {
    if (file.origin.kind !== 'zip') throw new ManifestError(`${file.id}: the regression corpus reads zip archives only`);
    const key = `${file.source} ${file.origin.archive}`;
    if (!archives.has(key)) archives.set(key, archives.size);
  }
  const archiveRecords: ArchiveRecord[] = [...archives.keys()].map((key) => {
    const [source, url] = key.split(' ');
    return { url, source };
  });
  const rows = files.map((file) => JSON.stringify(rowOf(file, archives)));
  return [
    '{',
    `"schema": ${REGRESSION_SCHEMA_VERSION},`,
    `"sources": ${JSON.stringify(manifest.sources)},`,
    `"archives": ${JSON.stringify(archiveRecords)},`,
    `"columns": ${JSON.stringify(REGRESSION_COLUMNS)},`,
    '"files": [',
    rows.join(',\n'),
    ']',
    '}',
    '',
  ].join('\n');
}

function expand(json: RegressionManifestJson): CorpusManifest {
  if (JSON.stringify(json.columns) !== JSON.stringify(REGRESSION_COLUMNS)) throw new ManifestError(`regression manifest columns are ${JSON.stringify(json.columns)}, expected ${JSON.stringify(REGRESSION_COLUMNS)}`);
  const files = json.files.map((row): CorpusFile => {
    const [id, format, archiveIndex, entry, offset, compressedSize, method, size, sha256, producer] = row;
    const archive = json.archives[archiveIndex];
    if (archive === undefined) throw new ManifestError(`${id}: archive ${archiveIndex} is not in the archive list`);
    return {
      id,
      source: archive.source,
      format,
      size,
      sha256,
      origin: { kind: 'zip', archive: archive.url, entry, offset, compressedSize, method },
      ...(producer === '' ? {} : { producer }),
    };
  });
  return { schema: MANIFEST_SCHEMA, sources: json.sources, files };
}

/** The manifest, expanded and validated by the checks the real-world manifest uses (safe unique ids, digests, https origins). */
export function parseRegressionManifest(text: string): CorpusManifest {
  const json = JSON.parse(text) as RegressionManifestJson;
  if (json.schema !== REGRESSION_SCHEMA_VERSION) throw new ManifestError(`regression manifest schema ${json.schema}, expected ${REGRESSION_SCHEMA_VERSION}`);
  const manifest = expand(json);
  parseManifest(JSON.stringify(manifest));
  return manifest;
}

export function readRegressionManifest(file = REGRESSION_MANIFEST_PATH): CorpusManifest {
  return parseRegressionManifest(fs.readFileSync(file, 'utf8'));
}
