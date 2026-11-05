import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { locateLanguageData } from '../conversions/ocr-language-data';
import { resolveOcrLanguages } from '../conversions/ocr-languages';
import { EdgeOcrError } from './index';
import ocrAssetsManifest from './ocr-assets.manifest.json';

export const OCR_ASSET_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
export const OCR_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const TRAINEDDATA_SUFFIX = '.traineddata';
const TRAINEDDATA_GZ_SUFFIX = '.traineddata.gz';
const TRAINEDDATA_HEADER_COUNT_BYTES = 4;
const TRAINEDDATA_OFFSET_ENTRY_BYTES = 8;
const MAX_TRAINEDDATA_COMPONENTS = 64;
const MISSING_COMPONENT_OFFSET = -1n;
const CANONICAL_LANG_PATTERN = /^[a-z0-9_]+$/;

export type VerifiedOcrAssetResponse =
  | {
      status: 200;
      body: Buffer;
      contentType: string;
      sha256: string;
    }
  | {
      status: 404;
      detail: string;
    };

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function invalidTraineddataError(lang: string, cause?: unknown): EdgeOcrError {
  return new EdgeOcrError(`Edge OCR language data for '${lang}' failed integrity verification.`, { cause });
}

/**
 * Verifies the Tesseract traineddata header table: a 32-bit little-endian component count followed by
 * `entries` 64-bit little-endian component offsets (`-1` for absent components, or an offset inside the payload).
 */
export function verifyTraineddataBuffer(bytes: Buffer, lang: string): void {
  if (bytes.length < TRAINEDDATA_HEADER_COUNT_BYTES) {
    throw invalidTraineddataError(lang);
  }
  const entries = bytes.readInt32LE(0);
  const tableEnd = TRAINEDDATA_HEADER_COUNT_BYTES + entries * TRAINEDDATA_OFFSET_ENTRY_BYTES;
  if (entries < 1 || entries > MAX_TRAINEDDATA_COMPONENTS || tableEnd > bytes.length) {
    throw invalidTraineddataError(lang);
  }
  let presentComponents = 0;
  const minOffset = BigInt(tableEnd);
  const maxOffset = BigInt(bytes.length);
  for (let i = 0; i < entries; i++) {
    const offset = bytes.readBigInt64LE(TRAINEDDATA_HEADER_COUNT_BYTES + i * TRAINEDDATA_OFFSET_ENTRY_BYTES);
    if (offset === MISSING_COMPONENT_OFFSET) continue;
    presentComponents++;
    if (offset < minOffset || offset >= maxOffset) {
      throw invalidTraineddataError(lang);
    }
  }
  if (presentComponents === 0) {
    throw invalidTraineddataError(lang);
  }
}

function hasValidSegments(segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.includes('/') &&
      !segment.includes('\\')
  );
}

function loadManifestAsset(
  name: keyof typeof ocrAssetsManifest.assets,
  rootDir: string
): VerifiedOcrAssetResponse {
  const entry = ocrAssetsManifest.assets[name];
  const fullPath = path.join(rootDir, entry.packagePath);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(fullPath);
  } catch (err: unknown) {
    throw new EdgeOcrError(`Missing pinned OCR asset '${name}'.`, { cause: err });
  }
  const sha256 = sha256Hex(bytes);
  if (bytes.length !== entry.size || sha256 !== entry.sha256) {
    throw new EdgeOcrError(`OCR asset '${name}' failed SHA-256 manifest verification.`);
  }
  return {
    status: 200,
    body: bytes,
    contentType: 'application/javascript; charset=utf-8',
    sha256,
  };
}

function resolveTraineddataFileName(segments: readonly string[]): string | null {
  let candidate: string | null = null;
  if (segments.length === 2 && segments[0] === 'tessdata') {
    candidate = segments[1];
  } else if (segments.length === 1) {
    candidate = segments[0];
  }
  if (!candidate) return null;
  if (candidate.endsWith(TRAINEDDATA_GZ_SUFFIX) || candidate.endsWith(TRAINEDDATA_SUFFIX)) {
    return candidate;
  }
  return null;
}

function isCanonicalLanguageCode(rawLang: string): boolean {
  if (!CANONICAL_LANG_PATTERN.test(rawLang)) return false;
  try {
    const resolved = resolveOcrLanguages(rawLang);
    return resolved.traineddata.length === 1 && resolved.traineddata[0] === rawLang;
  } catch {
    return false;
  }
}

function encodeTraineddataBody(
  wantsGzip: boolean,
  locationGzip: boolean,
  diskBytes: Buffer,
  uncompressed: Buffer
): Buffer {
  if (!wantsGzip) return uncompressed;
  return locationGzip ? diskBytes : zlib.gzipSync(uncompressed);
}

function loadTraineddataAsset(fileName: string): VerifiedOcrAssetResponse {
  const wantsGzip = fileName.endsWith(TRAINEDDATA_GZ_SUFFIX);
  const suffix = wantsGzip ? TRAINEDDATA_GZ_SUFFIX : TRAINEDDATA_SUFFIX;
  const rawLang = fileName.slice(0, -suffix.length);
  if (!isCanonicalLanguageCode(rawLang)) {
    return { status: 404, detail: `Unknown OCR language '${rawLang}'.` };
  }
  const location = locateLanguageData(rawLang);
  if (!location) {
    return { status: 404, detail: `OCR language data for '${rawLang}' is not installed.` };
  }
  const diskPath = path.join(location.dir, `${rawLang}${TRAINEDDATA_SUFFIX}${location.gzip ? '.gz' : ''}`);
  let diskBytes: Buffer;
  try {
    diskBytes = fs.readFileSync(diskPath);
  } catch (err: unknown) {
    throw new EdgeOcrError(`Missing OCR language data file for '${rawLang}'.`, { cause: err });
  }
  let uncompressed: Buffer;
  try {
    uncompressed = location.gzip ? zlib.gunzipSync(diskBytes) : diskBytes;
  } catch (err: unknown) {
    throw invalidTraineddataError(rawLang, err);
  }
  verifyTraineddataBuffer(uncompressed, rawLang);
  const body = encodeTraineddataBody(wantsGzip, location.gzip, diskBytes, uncompressed);
  return {
    status: 200,
    body,
    contentType: 'application/octet-stream',
    sha256: sha256Hex(body),
  };
}

export function loadVerifiedOcrAsset(
  version: string,
  assetSegments: readonly string[],
  options?: { rootDir?: string }
): VerifiedOcrAssetResponse {
  if (version !== ocrAssetsManifest.tesseractVersion) {
    return { status: 404, detail: `Unknown OCR asset version '${version}'.` };
  }
  if (!hasValidSegments(assetSegments)) {
    return { status: 404, detail: 'OCR asset not found.' };
  }
  const rootDir = options?.rootDir ?? process.cwd();
  if (assetSegments.length === 1 && Object.hasOwn(ocrAssetsManifest.assets, assetSegments[0])) {
    return loadManifestAsset(assetSegments[0] as keyof typeof ocrAssetsManifest.assets, rootDir);
  }
  const traineddataFile = resolveTraineddataFileName(assetSegments);
  if (traineddataFile !== null) {
    return loadTraineddataAsset(traineddataFile);
  }
  return { status: 404, detail: 'OCR asset not found.' };
}
