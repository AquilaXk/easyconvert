/**
 * The real-world corpus manifest (bench/realworld/manifest.json): every file's origin, size, SHA-256 and licence. The
 * files themselves are never committed; the fetcher downloads them, checks each digest and keeps them in a cache.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
export const MANIFEST_SCHEMA = 1;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]*$/;

/** A file inside a ZIP archive, read with range requests. */
export interface ZipOrigin {
  kind: 'zip';
  archive: string;
  entry: string;
  /** Offset of the entry's local file header in the archive. */
  offset: number;
  compressedSize: number;
  /** ZIP compression method (0 stored, 8 deflated). */
  method: number;
}

/** A file served on its own at a URL pinned to a revision. */
export interface FileOrigin {
  kind: 'file';
  url: string;
}

export interface CorpusSource {
  id: string;
  description: string;
  /** Licence or redistribution statement of the source, as its publisher gives it. */
  licence: string;
}

export interface CorpusFile {
  id: string;
  source: string;
  origin: ZipOrigin | FileOrigin;
  /** Format identifier as the registry knows it (the source format of the conversions). */
  format: string;
  size: number;
  sha256: string;
}

export interface CorpusManifest {
  schema: number;
  sources: CorpusSource[];
  files: CorpusFile[];
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

function checkFile(file: CorpusFile, sources: ReadonlySet<string>, seen: Set<string>): void {
  if (!SAFE_ID.test(file.id)) throw new ManifestError(`file id ${JSON.stringify(file.id)} is not a safe file name`);
  if (seen.has(file.id)) throw new ManifestError(`duplicate file id ${file.id}`);
  seen.add(file.id);
  if (!sources.has(file.source)) throw new ManifestError(`${file.id}: unknown source ${file.source}`);
  if (!SHA256_HEX.test(file.sha256)) throw new ManifestError(`${file.id}: sha256 is not 64 lower-case hex digits`);
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new ManifestError(`${file.id}: size must be a positive integer`);
  if (typeof file.format !== 'string' || file.format === '') throw new ManifestError(`${file.id}: format is missing`);
  const origin = file.origin;
  if (origin.kind === 'zip') {
    if (!origin.archive.startsWith('https://') || origin.entry === '') throw new ManifestError(`${file.id}: zip origin needs an https archive and an entry`);
    if (!Number.isSafeInteger(origin.offset) || origin.offset < 0 || !Number.isSafeInteger(origin.compressedSize) || origin.compressedSize < 0) {
      throw new ManifestError(`${file.id}: zip origin needs a non-negative offset and compressed size`);
    }
  } else if (origin.kind === 'file') {
    if (!origin.url.startsWith('https://')) throw new ManifestError(`${file.id}: file origin needs an https URL`);
  } else {
    throw new ManifestError(`${file.id}: unknown origin kind`);
  }
}

/** The manifest, validated: known schema, licensed sources, safe unique ids, digests and https origins. */
export function parseManifest(json: string): CorpusManifest {
  const manifest = JSON.parse(json) as CorpusManifest;
  if (manifest.schema !== MANIFEST_SCHEMA) throw new ManifestError(`manifest schema ${manifest.schema}, expected ${MANIFEST_SCHEMA}`);
  const sources = new Set<string>();
  for (const source of manifest.sources) {
    if (!SAFE_ID.test(source.id) || source.licence.trim() === '') throw new ManifestError(`source ${source.id} needs a safe id and a licence statement`);
    sources.add(source.id);
  }
  const seen = new Set<string>();
  for (const file of manifest.files) checkFile(file, sources, seen);
  return manifest;
}

export function readManifest(file = MANIFEST_PATH): CorpusManifest {
  return parseManifest(fs.readFileSync(file, 'utf8'));
}
