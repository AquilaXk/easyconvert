import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * What a new text thread loads and keeps (see pdf-text-worker.ts). A thread is made again every 100 documents, and its start-up
 * is the one cost of a document that is not the reading: pdf-lib (27 ms), which only the image reader uses, is loaded by a thread
 * that reads a document with images, and pdfjs is compiled once and read from a code cache by the next thread. Both are
 * observed on real threads: the first through the modules a thread has loaded, the second through the files the threads leave.
 */

const SRC = path.join(__dirname, '..', 'src', 'lib', 'conversions');
const TEXT_ONLY_FIXTURE = path.join(__dirname, 'fixtures', 'pdf-text', 'latin.pdf');
const IMAGE_FIXTURE = path.join(__dirname, 'fixtures', 'pdf-structure', 'doc-04.pdf');
const TSX_API = createRequire(path.join(process.cwd(), 'package.json')).resolve('tsx/cjs/api');

/** Reads a text-only document and then one with images on one thread, and reports whether pdf-lib is loaded after each, and how many images the second gave. */
const LOADED_MODULES_PROBE = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
require(workerData.tsx).register();
const { analyzePdfPagesInProcess } = require(workerData.geometry);
const pdfLibLoaded = () => Object.keys(require.cache).some((file) => /node_modules[\\\\/]pdf-lib[\\\\/]/.test(file));
(async () => {
  await analyzePdfPagesInProcess(fs.readFileSync(workerData.textOnly), { geometry: 'none', content: true, images: true });
  const afterText = pdfLibLoaded();
  const withImages = await analyzePdfPagesInProcess(fs.readFileSync(workerData.withImages), { geometry: 'none', content: true, images: true });
  const images = withImages.content.reduce((total, page) => total + page.images.length, 0);
  parentPort.postMessage({ afterText, afterImages: pdfLibLoaded(), images: images > 0 });
})();
`;

const START_AS_SOURCE = (tsx: string, entry: string): string => `require(${JSON.stringify(tsx)}).register(); require(${JSON.stringify(entry)});`;

/** The thread entry, with its `ready` message stamped with whether pdf-lib is loaded and which code cache directory the thread uses when it is sent. */
const START_AND_REPORT_AT_READY = (tsx: string, entry: string): string => `
const { parentPort } = require('node:worker_threads');
const post = parentPort.postMessage.bind(parentPort);
parentPort.postMessage = (message) =>
  post(
    message?.ready
      ? {
          ...message,
          pdfLib: Object.keys(require.cache).some((file) => /node_modules[\\\\/]pdf-lib[\\\\/]/.test(file)),
          cacheDir: require('node:module').getCompileCacheDir() ?? null,
        }
      : message
  );
${START_AS_SOURCE(tsx, entry)}`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function onceMessage<T>(worker: Worker): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

describe('the modules a text thread loads', () => {
  it('loads the PDF object reader for the first page with images, and not for a document without', async () => {
    const worker = new Worker(LOADED_MODULES_PROBE, {
      eval: true,
      workerData: { tsx: TSX_API, geometry: path.join(SRC, 'pdf-text-geometry.ts'), textOnly: TEXT_ONLY_FIXTURE, withImages: IMAGE_FIXTURE },
    });
    const loaded = await onceMessage<{ afterText: boolean; afterImages: boolean; images: boolean }>(worker);
    await worker.terminate();
    expect(loaded).toEqual({ afterText: false, afterImages: true, images: true });
  });
});

describe('a replacement thread', () => {
  it.each([
    { images: true, pdfLib: true },
    { images: false, pdfLib: false },
  ])('has the PDF object reader loaded when it is ready only if its predecessor read images ($images)', async ({ images, pdfLib }) => {
    const worker = new Worker(START_AND_REPORT_AT_READY(TSX_API, path.join(SRC, 'pdf-text-worker.ts')), { eval: true, workerData: { warmUp: true, images } });
    const ready = await onceMessage<{ ready: boolean; pdfLib: boolean }>(worker);
    await worker.terminate();
    expect(ready).toMatchObject({ ready: true, pdfLib });
  });
});

describe('the code cache of a text thread', () => {
  async function readyReport(compileCacheDir: string | null): Promise<{ cacheDir: string | null }> {
    const worker = new Worker(START_AND_REPORT_AT_READY(TSX_API, path.join(SRC, 'pdf-text-worker.ts')), {
      eval: true,
      workerData: { warmUp: true, images: false, compileCacheDir },
      env: { ...process.env, NODE_COMPILE_CACHE: '' },
    });
    const report = await onceMessage<{ cacheDir: string | null }>(worker);
    await worker.terminate();
    return report;
  }

  it('uses the directory it is given, and leaves the compiled pdfjs there for the next thread', async () => {
    const cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-text-cache-')), 'code-cache');
    cleanups.push(() => fs.rmSync(path.dirname(cacheDir), { recursive: true, force: true }));
    const report = await readyReport(cacheDir);
    // Node keeps the entries of one version of itself in a directory of its own below the one it is given.
    expect(fs.realpathSync(path.dirname(report.cacheDir ?? ''))).toBe(fs.realpathSync(cacheDir));
    const cached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()) : [];
    expect(cached.length).toBeGreaterThan(0);
  });

  it('uses no code cache when it is given no directory', async () => {
    expect(await readyReport(null)).toMatchObject({ cacheDir: null });
  });
});
