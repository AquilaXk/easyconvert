#!/usr/bin/env node
// Downloads the camera-RAW sample files listed in tests/fixtures/raw/manifest.json into
// tests/fixtures/raw/.cache/<format>.<format>, verifying byte size and SHA-256.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'raw');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const CACHE_DIR = path.join(ROOT, '.cache');
const MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 1_000;
const REQUEST_TIMEOUT_MS = 120_000;
const HTTP_OK = 200;

function cachePathFor(entry) {
  return path.join(CACHE_DIR, `${entry.format}.${entry.format}`);
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function isIntact(buffer, entry) {
  return buffer.length === entry.bytes && sha256Of(buffer) === entry.sha256;
}

async function download(url) {
  if (new URL(url).protocol !== 'https:') throw new Error(`refusing non-HTTPS URL ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status !== HTTP_OK) throw new Error(`HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchEntry(entry) {
  const target = cachePathFor(entry);
  if (existsSync(target)) {
    if (isIntact(readFileSync(target), entry)) return 'cached';
    rmSync(target, { force: true });
  }
  let lastError = 'unknown error';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const buffer = await download(entry.url);
      if (!isIntact(buffer, entry)) {
        // A corrupt or substituted download is never kept and never retried silently.
        throw Object.assign(new Error(`integrity mismatch (got ${buffer.length} bytes, sha256 ${sha256Of(buffer)})`), {
          fatal: true,
        });
      }
      const partial = `${target}.part`;
      writeFileSync(partial, buffer);
      renameSync(partial, target);
      return 'downloaded';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      rmSync(target, { force: true });
      if (err?.fatal || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw new Error(lastError);
}

/**
 * Node's built-in fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY is set at startup, so a
 * proxied environment re-runs this script once with it enabled.
 */
function relaunchWithEnvProxy() {
  const proxied = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxied || process.env.NODE_USE_ENV_PROXY) return;
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(result.status ?? 1);
}

async function main() {
  relaunchWithEnvProxy();
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  mkdirSync(CACHE_DIR, { recursive: true });
  let failures = 0;
  for (const entry of manifest) {
    try {
      const status = await fetchEntry(entry);
      console.log(`${status}: ${entry.format} (${entry.bytes} bytes)`);
    } catch (err) {
      failures += 1;
      console.error(`FAILED: ${entry.format}: ${err.message}`);
    }
  }
  if (failures > 0) {
    console.error(`${failures} of ${manifest.length} RAW samples could not be fetched`);
    process.exit(1);
  }
}

await main();
