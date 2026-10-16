import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { OCR_PREPROCESS_STEPS, preprocessOcrImage } from '../src/lib/conversions/ocr-preprocess';

// Temporary measurement of the engine builds on the CI runner; removed before the pull request is final.
const ROOT = process.cwd();
const WORKER = `
const { parentPort } = require('worker_threads');
const root = process.env.PROBE_ROOT;
const worker = require(root + '/node_modules/tesseract.js/src/worker-script');
const gunzip = require(root + '/node_modules/tesseract.js/src/worker-script/node/gunzip');
const cache = require(root + '/node_modules/tesseract.js/src/worker-script/node/cache');
let core = null;
const getCore = async (lstmOnly, _p, res) => { if (core === null) core = require(root + '/node_modules/tesseract.js-core/tesseract-core-' + process.env.PROBE_CORE); return core; };
parentPort.on('message', (packet) => worker.dispatchHandlers(packet, (obj) => parentPort.postMessage(obj)));
worker.setAdapter({ getCore, gunzip, fetch: global.fetch, ...cache });
`;
const CHILD = `
const fs = require('fs');
const root = process.env.PROBE_ROOT;
if (process.env.PROBE_RELAXED === '1') require('v8').setFlagsFromString('--experimental-wasm-relaxed-simd');
const T = require(root + '/node_modules/tesseract.js');
(async () => {
  const dirs = ['/usr/share/tesseract-ocr/5/tessdata', '/usr/share/tesseract-ocr/4.00/tessdata', '/usr/share/tessdata', '/opt/homebrew/share/tessdata'];
  const langPath = dirs.find((d) => fs.existsSync(d + '/eng.traineddata'));
  const opts = { langPath, cacheMethod: 'none', gzip: false };
  if (process.env.PROBE_CORE) opts.workerPath = process.env.PROBE_WORKER;
  const w = await T.createWorker('eng', 1, opts);
  await w.setParameters({ tessedit_pageseg_mode: '3' });
  const img = fs.readFileSync(process.env.PROBE_IMAGE);
  for (let i = 0; i < 3; i++) await w.recognize(img, {}, { blocks: true });
  const ts = [];
  for (let i = 0; i < 12; i++) { const t = performance.now(); await w.recognize(img, {}, { blocks: true }); ts.push(performance.now() - t); }
  ts.sort((a, b) => a - b);
  console.log(JSON.stringify({ median: ts[0] }));
  await w.terminate();
})();
`;

function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[values.length >> 1];
}

describe('engine build probe', () => {
  it('times the engine builds on this machine', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-probe-'));
    const prepared = await preprocessOcrImage(fs.readFileSync(path.join(ROOT, 'bench/corpus/scan.png')), { ...OCR_PREPROCESS_STEPS, binarize: false });
    const image = path.join(dir, 'prepared.pgm');
    fs.writeFileSync(image, prepared.image);
    fs.writeFileSync(path.join(dir, 'worker.cjs'), WORKER);
    fs.writeFileSync(path.join(dir, 'child.cjs'), CHILD);
    const variants: Record<string, Record<string, string>> = {
      'default (simd core)': {},
      'relaxed flag (relaxedsimd core)': { PROBE_RELAXED: '1' },
      'simd-lstm core': { PROBE_CORE: 'simd-lstm' },
      'relaxedsimd-lstm core': { PROBE_CORE: 'relaxedsimd-lstm', PROBE_RELAXED: '1' },
    };
    const times: Record<string, number[]> = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
    for (let round = 0; round < 8; round++) {
      for (const [name, extra] of Object.entries(variants)) {
        const out = execFileSync(process.execPath, [path.join(dir, 'child.cjs')], {
          env: { ...process.env, PROBE_ROOT: ROOT, PROBE_IMAGE: image, PROBE_WORKER: path.join(dir, 'worker.cjs'), OMP_THREAD_LIMIT: '1', ...extra },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        times[name].push((JSON.parse(out.trim().split('\n').pop() as string) as { median: number }).median);
      }
    }
    const lines = Object.entries(times).map(([k, v]) => `${k.padEnd(34)} best-of-12 per run: min ${Math.min(...v).toFixed(1)} median ${median(v).toFixed(1)} ms   runs ${v.map((x) => x.toFixed(0)).join(' ')}`);
    const tesseract = spawnSync('tesseract', [image, path.join(dir, 'cli'), '-l', 'eng', '--psm', '3', '--oem', '1'], { env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
    const cli: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      spawnSync('tesseract', [image, path.join(dir, 'cli'), '-l', 'eng', '--psm', '3', '--oem', '1'], { env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
      cli.push(performance.now() - start);
    }
    lines.push(`native CLI on the same page (1 thread, with start-up) min ${Math.min(...cli).toFixed(1)} median ${median(cli).toFixed(1)} ms (exit ${tesseract.status})`);
    const raw: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      spawnSync('tesseract', [path.join(ROOT, 'bench/corpus/scan.png'), path.join(dir, 'cli'), '-l', 'eng', '--psm', '3', '--oem', '1', 'pdf'], { env: { ...process.env, OMP_THREAD_LIMIT: '1' } });
      raw.push(performance.now() - start);
    }
    lines.push(`native CLI reference command on the raw scan min ${Math.min(...raw).toFixed(1)} median ${median(raw).toFixed(1)} ms`);
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`PROBE cpu=${os.cpus()[0].model} cores=${os.availableParallelism()} node=${process.version}\nPROBE ${lines.join('\nPROBE ')}`);
  }, 600_000);
});
