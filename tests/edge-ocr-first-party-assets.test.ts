import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import { tryToParsePath } from 'next/dist/lib/try-to-parse-path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createWorker = vi.fn();
vi.mock('tesseract.js', () => ({ default: { createWorker }, createWorker }));

import nextConfigFactory from '../next.config.mjs';
import { GET as getOcrAsset } from '../src/app/api/ocr-assets/[version]/[...asset]/route';
import { locateLanguageData, resetInstalledTraineddata } from '../src/lib/conversions/ocr-language-data';
import {
  EDGE_OCR_ASSET_BASE_PATH,
  EDGE_OCR_ASSET_VERSION,
  EDGE_OCR_CORE_PATH,
  EDGE_OCR_LANG_PATH,
  EDGE_OCR_WORKER_PATH,
  EdgeOcrError,
  runClientEdgeOcr,
} from '../src/lib/edge-ocr';
import {
  OCR_ASSET_CACHE_CONTROL,
  OCR_ASSET_CSP,
  loadVerifiedOcrAsset,
  verifyTraineddataBuffer,
} from '../src/lib/edge-ocr/assets';
import ocrAssetsManifest from '../src/lib/edge-ocr/ocr-assets.manifest.json';
import { config as middlewareConfig } from '../src/middleware';

const RECOGNIZED_BLOCKS = [
  {
    paragraphs: [
      {
        lines: [
          {
            text: 'FIRST PARTY OCR',
            bbox: { x0: 8, y0: 12, x1: 140, y1: 32 },
            words: [
              { text: 'FIRST', confidence: 93, bbox: { x0: 8, y0: 12, x1: 50, y1: 32 } },
              { text: 'PARTY', confidence: 92, bbox: { x0: 56, y0: 12, x1: 100, y1: 32 } },
              { text: 'OCR', confidence: 94, bbox: { x0: 106, y0: 12, x1: 140, y1: 32 } },
            ],
          },
        ],
      },
    ],
  },
];

async function makeScanFile(): Promise<File> {
  const png = await sharp({
    create: { width: 160, height: 48, channels: 3, background: '#ffffff' },
  })
    .png()
    .toBuffer();
  return new File([new Uint8Array(png)], 'scan.png', { type: 'image/png' });
}

function buildValidTraineddataBuffer(): Buffer {
  const entries = 3;
  const headerBytes = 4 + entries * 8;
  const payload = Buffer.from('TESSERACT-COMPONENT-DATA', 'utf-8');
  const buf = Buffer.alloc(headerBytes + payload.length);
  buf.writeInt32LE(entries, 0);
  buf.writeBigInt64LE(BigInt(headerBytes), 4);
  buf.writeBigInt64LE(-1n, 12);
  buf.writeBigInt64LE(BigInt(headerBytes + 4), 20);
  payload.copy(buf, headerBytes);
  return buf;
}

describe('first-party Edge OCR assets and worker configuration', () => {
  const originalTessdataPrefix = process.env.TESSDATA_PREFIX;

  beforeEach(() => {
    createWorker.mockReset();
  });

  afterEach(() => {
    if (originalTessdataPrefix === undefined) {
      delete process.env.TESSDATA_PREFIX;
    } else {
      process.env.TESSDATA_PREFIX = originalTessdataPrefix;
    }
    resetInstalledTraineddata();
    vi.restoreAllMocks();
  });

  it('configures Tesseract.createWorker with first-party workerPath, corePath, and langPath and no third-party CDN URLs', async () => {
    createWorker.mockResolvedValue({
      recognize: vi.fn(async () => ({
        data: { text: 'FIRST PARTY OCR', confidence: 93, blocks: RECOGNIZED_BLOCKS },
      })),
      terminate: vi.fn(async () => undefined),
    });

    const result = await runClientEdgeOcr(await makeScanFile(), { ocrEnabled: true, ocrLanguage: 'eng' });

    expect(result.text).toBe('FIRST PARTY OCR');
    expect(createWorker).toHaveBeenCalledTimes(1);
    const [lang, oem, workerOptions] = createWorker.mock.calls[0];
    expect(lang).toBe('eng');
    expect(oem).toBe(1);
    expect(workerOptions).toMatchObject({
      workerPath: EDGE_OCR_WORKER_PATH,
      corePath: EDGE_OCR_CORE_PATH,
      langPath: EDGE_OCR_LANG_PATH,
      gzip: false,
      workerBlobURL: false,
      cacheMethod: 'none',
    });
    expect(EDGE_OCR_WORKER_PATH).toBe('/_assets/ocr/7.0.0/worker.min.js');
    expect(EDGE_OCR_CORE_PATH).toBe('/_assets/ocr/7.0.0');
    expect(EDGE_OCR_LANG_PATH).toBe('/_assets/ocr/7.0.0/tessdata');
    for (const urlPath of [EDGE_OCR_ASSET_BASE_PATH, EDGE_OCR_WORKER_PATH, EDGE_OCR_CORE_PATH, EDGE_OCR_LANG_PATH]) {
      expect(urlPath.startsWith('/_assets/ocr/')).toBe(true);
      expect(urlPath).not.toMatch(/https?:\/\/|jsdelivr/i);
    }
  });

  it('rejects unknown OCR language codes with EdgeOcrError before invoking Tesseract.createWorker', async () => {
    const file = await makeScanFile();

    await expect(runClientEdgeOcr(file, { ocrEnabled: true, ocrLanguage: 'xx_unknown_lang' })).rejects.toBeInstanceOf(
      EdgeOcrError
    );
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('matches every pinned entry in ocr-assets.manifest.json against the installed files in node_modules', () => {
    const tesseractPkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'node_modules/tesseract.js/package.json'), 'utf-8')
    ) as { version: string };
    const corePkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'node_modules/tesseract.js-core/package.json'), 'utf-8')
    ) as { version: string };

    expect(ocrAssetsManifest.tesseractVersion).toBe(EDGE_OCR_ASSET_VERSION);
    expect(ocrAssetsManifest.tesseractVersion).toBe(tesseractPkg.version);
    expect(ocrAssetsManifest.coreVersion).toBe(corePkg.version);

    for (const [assetName, meta] of Object.entries(ocrAssetsManifest.assets)) {
      const fullPath = path.join(process.cwd(), meta.packagePath);
      const bytes = fs.readFileSync(fullPath);
      const actualSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(bytes.length, `${assetName} byte size`).toBe(meta.size);
      expect(actualSha256, `${assetName} sha256`).toBe(meta.sha256);
    }
  });

  it('serves worker.min.js and WASM core scripts over GET /api/ocr-assets/7.0.0/... with strict CSP, immutable cache, and ETag', async () => {
    for (const assetName of ['worker.min.js', 'tesseract-core-simd-lstm.wasm.js'] as const) {
      const expected = ocrAssetsManifest.assets[assetName];
      const req = new NextRequest(`http://localhost:3000/api/ocr-assets/7.0.0/${assetName}`);
      const res = await getOcrAsset(req, {
        params: Promise.resolve({ version: '7.0.0', asset: [assetName] }),
      });

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(OCR_ASSET_CSP);
      expect(res.headers.get('cache-control')).toBe(OCR_ASSET_CACHE_CONTROL);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('etag')).toBe(`"sha256-${expected.sha256}"`);

      const body = Buffer.from(await res.arrayBuffer());
      expect(body.length).toBe(expected.size);
      expect(crypto.createHash('sha256').update(body).digest('hex')).toBe(expected.sha256);
    }
  });

  it('fails closed with EdgeOcrError and HTTP 500 problem+json when a pinned JS/WASM asset is tampered with', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-asset-tamper-'));
    try {
      for (const assetName of ['worker.min.js', 'tesseract-core-lstm.wasm.js'] as const) {
        const meta = ocrAssetsManifest.assets[assetName];
        const srcPath = path.join(process.cwd(), meta.packagePath);
        const destPath = path.join(tempRoot, meta.packagePath);
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        const tampered = Buffer.from(fs.readFileSync(srcPath));
        tampered[0] ^= 0xff;
        fs.writeFileSync(destPath, tampered);

        expect(() => loadVerifiedOcrAsset('7.0.0', [assetName], { rootDir: tempRoot })).toThrow(EdgeOcrError);
      }

      vi.spyOn(process, 'cwd').mockReturnValue(tempRoot);
      const req = new NextRequest('http://localhost:3000/api/ocr-assets/7.0.0/worker.min.js');
      const res = await getOcrAsset(req, {
        params: Promise.resolve({ version: '7.0.0', asset: ['worker.min.js'] }),
      });
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      const problem = (await res.json()) as { type: string; status: number; detail: string };
      expect(problem.status).toBe(500);
      expect(problem.type).toBe('https://api.easyconvert.io/problems/ocr-asset-integrity-failed');
      expect(problem.detail).toMatch(/SHA-256 manifest verification/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('serves verified traineddata, rejects unknown languages or versions with 404, and rejects corrupted traineddata with 500', async () => {
    const validTraineddata = buildValidTraineddataBuffer();
    expect(() => verifyTraineddataBuffer(validTraineddata, 'eng')).not.toThrow();

    const tempTessdata = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-tessdata-'));
    try {
      const existingEng = locateLanguageData('eng');
      if (!existingEng) {
        fs.writeFileSync(path.join(tempTessdata, 'eng.traineddata'), validTraineddata);
        process.env.TESSDATA_PREFIX = tempTessdata;
        resetInstalledTraineddata();
      }

      const okReq = new NextRequest('http://localhost:3000/api/ocr-assets/7.0.0/tessdata/eng.traineddata');
      const okRes = await getOcrAsset(okReq, {
        params: Promise.resolve({ version: '7.0.0', asset: ['tessdata', 'eng.traineddata'] }),
      });
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('content-type')).toBe('application/octet-stream');
      expect(okRes.headers.get('content-security-policy')).toBe(OCR_ASSET_CSP);
      const servedBytes = Buffer.from(await okRes.arrayBuffer());
      expect(() => verifyTraineddataBuffer(servedBytes, 'eng')).not.toThrow();

      const unknownLangReq = new NextRequest(
        'http://localhost:3000/api/ocr-assets/7.0.0/tessdata/xx_unknown.traineddata'
      );
      const unknownLangRes = await getOcrAsset(unknownLangReq, {
        params: Promise.resolve({ version: '7.0.0', asset: ['tessdata', 'xx_unknown.traineddata'] }),
      });
      expect(unknownLangRes.status).toBe(404);

      const unknownVerReq = new NextRequest('http://localhost:3000/api/ocr-assets/6.0.0/worker.min.js');
      const unknownVerRes = await getOcrAsset(unknownVerReq, {
        params: Promise.resolve({ version: '6.0.0', asset: ['worker.min.js'] }),
      });
      expect(unknownVerRes.status).toBe(404);

      fs.writeFileSync(path.join(tempTessdata, 'eng.traineddata'), Buffer.from([0x05, 0x00, 0x00, 0x00, 0xff]));
      process.env.TESSDATA_PREFIX = tempTessdata;
      resetInstalledTraineddata();

      const corruptReq = new NextRequest('http://localhost:3000/api/ocr-assets/7.0.0/tessdata/eng.traineddata');
      const corruptRes = await getOcrAsset(corruptReq, {
        params: Promise.resolve({ version: '7.0.0', asset: ['tessdata', 'eng.traineddata'] }),
      });
      expect(corruptRes.status).toBe(500);
      expect(corruptRes.headers.get('content-type')).toBe('application/problem+json');
      const problem = (await corruptRes.json()) as { status: number; detail: string };
      expect(problem.status).toBe(500);
      expect(problem.detail).toMatch(/failed integrity verification/);
    } finally {
      fs.rmSync(tempTessdata, { recursive: true, force: true });
    }
  });

  it('skips /_assets/ocr/... in the locale middleware matcher and rewrites it to /api/ocr-assets/... in next.config.mjs', async () => {
    const matchers = middlewareConfig.matcher.map((source) => new RegExp(tryToParsePath(source).regexStr!));
    const matched = (pathname: string) => matchers.some((matcher) => matcher.test(pathname));

    expect(matched('/_assets/ocr/7.0.0/worker.min.js')).toBe(false);
    expect(matched('/_assets/ocr/7.0.0/tesseract-core-simd-lstm.wasm.js')).toBe(false);
    expect(matched('/_assets/ocr/7.0.0/tessdata/eng.traineddata')).toBe(false);

    for (const phase of [PHASE_PRODUCTION_SERVER, PHASE_PRODUCTION_BUILD]) {
      const cfg = await nextConfigFactory(phase);
      const rewrites = await cfg.rewrites?.();
      expect(rewrites).toEqual([
        {
          source: '/_assets/ocr/:version/:asset*',
          destination: '/api/ocr-assets/:version/:asset*',
        },
      ]);
    }
  });
});
