import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isValidTraineddataHeader, locateLanguageData } from '../conversions/ocr-language-data';
import { resolveOcrLanguages } from '../conversions/ocr-languages';
import { EdgeOcrError } from './index';
import ocrAssetsManifest from './ocr-assets.manifest.json';

export const OCR_ASSET_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'";
export const OCR_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const MAX_TRAINEDDATA_BYTES = 128 * 1024 * 1024;

const TRAINEDDATA_SUFFIX = '.traineddata';
const CANONICAL_LANG_PATTERN = /^[a-z0-9_]+$/;
const MAX_CACHED_ASSETS = 32;

export type VerifiedOcrAssetSuccess = {
  status: 200;
  body: Buffer;
  contentType: string;
  sha256: string;
};

export type VerifiedOcrAssetResponse =
  | VerifiedOcrAssetSuccess
  | {
      status: 404;
      detail: string;
    };

const verifiedAssetCache = new Map<string, VerifiedOcrAssetSuccess>();

function rememberVerifiedAsset(key: string, asset: VerifiedOcrAssetSuccess): VerifiedOcrAssetSuccess {
  if (verifiedAssetCache.size >= MAX_CACHED_ASSETS && !verifiedAssetCache.has(key)) {
    const oldestKey = verifiedAssetCache.keys().next().value;
    if (oldestKey !== undefined) {
      verifiedAssetCache.delete(oldestKey);
    }
  }
  verifiedAssetCache.set(key, asset);
  return asset;
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function invalidTraineddataError(lang: string, cause?: unknown): EdgeOcrError {
  return new EdgeOcrError(`Edge OCR language data for '${lang}' failed integrity verification.`, { cause });
}

export function verifyTraineddataBuffer(bytes: Buffer, lang: string): void {
  if (!isValidTraineddataHeader(bytes)) {
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
  let stat: fs.Stats;
  let bytes: Buffer;
  try {
    stat = fs.statSync(fullPath);
    const cacheKey = `manifest:${fullPath}:${stat.size}:${stat.mtimeMs}`;
    const cached = verifiedAssetCache.get(cacheKey);
    if (cached) return cached;
    bytes = fs.readFileSync(fullPath);
    const sha256 = sha256Hex(bytes);
    if (bytes.length !== entry.size || sha256 !== entry.sha256) {
      throw new EdgeOcrError(`OCR asset '${name}' failed SHA-256 manifest verification.`);
    }
    return rememberVerifiedAsset(cacheKey, {
      status: 200,
      body: bytes,
      contentType: 'application/javascript; charset=utf-8',
      sha256,
    });
  } catch (err: unknown) {
    if (err instanceof EdgeOcrError) throw err;
    throw new EdgeOcrError(`Missing pinned OCR asset '${name}'.`, { cause: err });
  }
}

function resolveTraineddataLanguage(segments: readonly string[]): string | null {
  if (segments.length !== 2 || segments[0] !== 'tessdata') {
    return null;
  }
  const fileName = segments[1];
  if (!fileName.endsWith(TRAINEDDATA_SUFFIX)) {
    return null;
  }
  return fileName.slice(0, -TRAINEDDATA_SUFFIX.length);
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

function loadTraineddataAsset(rawLang: string): VerifiedOcrAssetResponse {
  if (!isCanonicalLanguageCode(rawLang)) {
    return { status: 404, detail: `Unknown OCR language '${rawLang}'.` };
  }
  const location = locateLanguageData(rawLang);
  if (!location) {
    return { status: 404, detail: `OCR language data for '${rawLang}' is not installed.` };
  }
  const diskPath = path.join(location.dir, `${rawLang}${TRAINEDDATA_SUFFIX}${location.gzip ? '.gz' : ''}`);
  let stat: fs.Stats;
  let diskBytes: Buffer;
  try {
    stat = fs.statSync(diskPath);
    if (stat.size > MAX_TRAINEDDATA_BYTES) {
      throw invalidTraineddataError(rawLang);
    }
    const cacheKey = `traineddata:${diskPath}:${stat.size}:${stat.mtimeMs}`;
    const cached = verifiedAssetCache.get(cacheKey);
    if (cached) return cached;
    diskBytes = fs.readFileSync(diskPath);
    if (diskBytes.length > MAX_TRAINEDDATA_BYTES) {
      throw invalidTraineddataError(rawLang);
    }
    let uncompressed: Buffer;
    try {
      uncompressed = location.gzip
        ? zlib.gunzipSync(diskBytes, { maxOutputLength: MAX_TRAINEDDATA_BYTES })
        : diskBytes;
    } catch (err: unknown) {
      throw invalidTraineddataError(rawLang, err);
    }
    verifyTraineddataBuffer(uncompressed, rawLang);
    return rememberVerifiedAsset(cacheKey, {
      status: 200,
      body: uncompressed,
      contentType: 'application/octet-stream',
      sha256: sha256Hex(uncompressed),
    });
  } catch (err: unknown) {
    if (err instanceof EdgeOcrError) throw err;
    throw new EdgeOcrError(`Missing OCR language data file for '${rawLang}'.`, { cause: err });
  }
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
  const traineddataLang = resolveTraineddataLanguage(assetSegments);
  if (traineddataLang !== null) {
    return loadTraineddataAsset(traineddataLang);
  }
  return { status: 404, detail: 'OCR asset not found.' };
}
