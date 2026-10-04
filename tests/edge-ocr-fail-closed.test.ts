import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { ConversionQueueItem } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath } from './helpers/differential-oracle';

/**
 * Edge OCR must never report success without recognized text: an OCR engine that fails to load
 * or recognizes nothing escalates to the cloud tier (L4) exactly once, and the cloud result
 * records L2 as the tier it fell back from.
 */

// The OCR engine is a third-party dependency; each test decides how it behaves.
const createWorker = vi.fn();
vi.mock('tesseract.js', () => ({ default: { createWorker }, createWorker }));
vi.mock('../src/lib/edge/tier-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/tier-router')>();
  return { ...actual, resolveConversionTier: vi.fn() };
});

import { runClientEdgeOcr, EdgeOcrError } from '../src/lib/edge-ocr';
import { executeItemConversion } from '../src/lib/client-converter';
import { resolveConversionTier } from '../src/lib/edge/tier-router';

const { resolveConversionTier: routeByRules } = await vi.importActual<
  typeof import('../src/lib/edge/tier-router')
>('../src/lib/edge/tier-router');

const RECOGNIZED_TEXT = 'INVOICE 2026 TOTAL 42';
const RECOGNIZED_CONFIDENCE_PERCENT = 87;

const SCAN_WIDTH = 320;
const SCAN_HEIGHT = 80;
const GLYPH_WIDTH_PX = 12;
const WORD_GAP_PX = 8;
const LINE_LEFT_PX = 10;
const LINE_TOP_PX = 30;
const LINE_BOTTOM_PX = 50;

function recognizedWords() {
  let x = LINE_LEFT_PX;
  return RECOGNIZED_TEXT.split(' ').map((word) => {
    const bbox = { x0: x, y0: LINE_TOP_PX, x1: x + word.length * GLYPH_WIDTH_PX, y1: LINE_BOTTOM_PX };
    x = bbox.x1 + WORD_GAP_PX;
    return { text: word, confidence: RECOGNIZED_CONFIDENCE_PERCENT, bbox };
  });
}

// The block tree the OCR engine returns for one recognized line, in image pixel coordinates.
const WORDS = recognizedWords();
const RECOGNIZED_BLOCKS = [
  {
    paragraphs: [
      {
        lines: [
          {
            text: RECOGNIZED_TEXT,
            bbox: { x0: LINE_LEFT_PX, y0: LINE_TOP_PX, x1: WORDS[WORDS.length - 1].bbox.x1, y1: LINE_BOTTOM_PX },
            words: WORDS,
          },
        ],
      },
    ],
  },
];

async function scanPng(): Promise<Uint8Array<ArrayBuffer>> {
  const png = await sharp({ create: { width: SCAN_WIDTH, height: SCAN_HEIGHT, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

function workerReturning(data: Record<string, unknown>) {
  return {
    recognize: vi.fn(async () => ({ data })),
    terminate: vi.fn(async () => undefined),
  };
}

async function scanItem(options: ConversionQueueItem['options'] = {}): Promise<ConversionQueueItem> {
  const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });
  return {
    id: 'edge-ocr-scan',
    file,
    name: 'scan.png',
    size: file.size,
    sourceFormat: 'png',
    targetFormat: 'pdf',
    status: 'ready',
    progress: 0,
    options: { ocrEnabled: true, ...options },
  };
}

beforeEach(() => {
  createWorker.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runClientEdgeOcr', () => {
  it('rejects with EdgeOcrError when the OCR engine cannot load', async () => {
    createWorker.mockRejectedValue(new Error('language data fetch failed: 403'));
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    const attempt = runClientEdgeOcr(file, { ocrEnabled: true });

    await expect(attempt).rejects.toBeInstanceOf(EdgeOcrError);
    await expect(attempt).rejects.toThrow(/language data fetch failed: 403/);
  });

  it('rejects when recognition returns no text instead of producing an image-only PDF', async () => {
    createWorker.mockResolvedValue(workerReturning({ text: '  \n', confidence: 0, blocks: [] }));
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    await expect(runClientEdgeOcr(file, { ocrEnabled: true })).rejects.toThrow(/no text/i);
  });

  it('rejects when the engine reports no confidence instead of inventing one', async () => {
    createWorker.mockResolvedValue(workerReturning({ text: RECOGNIZED_TEXT, blocks: RECOGNIZED_BLOCKS }));
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    await expect(runClientEdgeOcr(file, { ocrEnabled: true })).rejects.toThrow(/confidence/i);
  });

  it('rejects recognized text that carries no line geometry, which would leave the PDF unsearchable', async () => {
    createWorker.mockResolvedValue(
      workerReturning({ text: RECOGNIZED_TEXT, confidence: RECOGNIZED_CONFIDENCE_PERCENT, blocks: [] })
    );
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    await expect(runClientEdgeOcr(file, { ocrEnabled: true })).rejects.toThrow(/line geometry/i);
  });

  it('rejects PDF input, which needs page rasterization the edge tier does not have', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 500]);
    const file = new File([new Uint8Array(await doc.save())], 'scan.pdf', { type: 'application/pdf' });

    await expect(runClientEdgeOcr(file, { ocrEnabled: true })).rejects.toBeInstanceOf(EdgeOcrError);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects non-PNG/JPEG input before running the engine or embedding it', async () => {
    const webp = await sharp({ create: { width: SCAN_WIDTH, height: SCAN_HEIGHT, channels: 3, background: '#ffffff' } })
      .webp()
      .toBuffer();
    // RIFF....WEBP: confirms the fixture really is WebP, not a PNG under another name.
    expect(webp.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(webp.subarray(8, 12).toString('latin1')).toBe('WEBP');
    const file = new File([new Uint8Array(webp)], 'scan.webp', { type: 'image/webp' });

    const attempt = runClientEdgeOcr(file, { ocrEnabled: true });

    await expect(attempt).rejects.toBeInstanceOf(EdgeOcrError);
    await expect(attempt).rejects.toThrow(/PNG or JPEG/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('rejects WebP bytes mislabeled as JPEG instead of handing them to the JPEG embedder', async () => {
    const webp = await sharp({ create: { width: SCAN_WIDTH, height: SCAN_HEIGHT, channels: 3, background: '#ffffff' } })
      .webp()
      .toBuffer();
    const file = new File([new Uint8Array(webp)], 'scan.jpg', { type: 'image/jpeg' });

    await expect(runClientEdgeOcr(file, { ocrEnabled: true })).rejects.toBeInstanceOf(EdgeOcrError);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('terminates the engine worker when recognition throws', async () => {
    const worker = {
      recognize: vi.fn(async () => {
        throw new Error('wasm memory exhausted');
      }),
      terminate: vi.fn(async () => undefined),
    };
    createWorker.mockResolvedValue(worker);
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    const attempt = runClientEdgeOcr(file, { ocrEnabled: true });

    await expect(attempt).rejects.toBeInstanceOf(EdgeOcrError);
    await expect(attempt).rejects.toThrow(/wasm memory exhausted/);
    expect(worker.recognize).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('reports the confidence the engine measured', async () => {
    createWorker.mockResolvedValue(
      workerReturning({ text: RECOGNIZED_TEXT, confidence: RECOGNIZED_CONFIDENCE_PERCENT, blocks: RECOGNIZED_BLOCKS })
    );
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    const result = await runClientEdgeOcr(file, { ocrEnabled: true });

    expect(result.text).toBe(RECOGNIZED_TEXT);
    expect(result.confidence).toBeCloseTo(RECOGNIZED_CONFIDENCE_PERCENT / 100, 5);
    expect(result.filename).toBe('scan.pdf');
  });

  oracleTest('embeds the recognized text as a layer that pdftotext extracts', ['pdftotext'], async () => {
    createWorker.mockResolvedValue(
      workerReturning({ text: RECOGNIZED_TEXT, confidence: RECOGNIZED_CONFIDENCE_PERCENT, blocks: RECOGNIZED_BLOCKS })
    );
    const file = new File([await scanPng()], 'scan.png', { type: 'image/png' });

    const result = await runClientEdgeOcr(file, { ocrEnabled: true });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-ocr-'));
    try {
      const pdfPath = path.join(dir, 'out.pdf');
      fs.writeFileSync(pdfPath, Buffer.from(await result.blob.arrayBuffer()));
      const pdftotext = getOracleToolPath('pdftotext') as string;
      const extracted = execFileSync(pdftotext, [pdfPath, '-'], { encoding: 'utf8' });
      expect(extracted.replace(/\s+/g, ' ').trim()).toBe(RECOGNIZED_TEXT);
      const loaded = await PDFDocument.load(fs.readFileSync(pdfPath));
      expect(loaded.getPageCount()).toBe(1);
      expect(loaded.getPage(0).getSize()).toEqual({ width: SCAN_WIDTH, height: SCAN_HEIGHT });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('edge OCR failure escalates to the cloud tier', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    vi.mocked(resolveConversionTier).mockReturnValue({
      tier: 'L2',
      tierName: 'Edge L2 (SIMD Wasm)',
      isClientEdge: true,
      reason: 'routed by test',
    });
    createWorker.mockRejectedValue(new Error('language data fetch failed: 403'));
  });

  it('sends exactly one cloud request and records L2 as the fallback source', async () => {
    const cloudBody = new Blob(['%PDF-1.7 cloud'], { type: 'application/pdf' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => cloudBody,
    } as Response);
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await executeItemConversion(await scanItem(), { onProgress: () => undefined, onSuccess, onError });

    expect(onError).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/convert');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const [, size, edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
    expect(size).toBe(cloudBody.size);
    expect(edgeProcessed).toBe(false);
    expect(tierName).toBe('Cloud (Zero-Retention)');
    expect(fallback.fallbackFrom).toBe('L2');
    expect(fallback.escalationReason).toMatch(/language data fetch failed: 403/);
  });

  it('fails without uploading in client-only edge mode', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await executeItemConversion(await scanItem({ clientEdgeMode: true }), {
      onProgress: () => undefined,
      onSuccess,
      onError,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/client-only edge mode/);
    // The specific edge OCR failure is reported, not only the generic client-only message.
    expect(onError.mock.calls[0][0]).toMatch(/L2/);
    expect(onError.mock.calls[0][0]).toMatch(/language data fetch failed: 403/);
  });
});

describe('edge OCR only produces searchable PDFs', () => {
  const cloudBody = new Blob(['INVOICE 2026 TOTAL 42'], { type: 'text/plain' });

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    createWorker.mockResolvedValue(
      workerReturning({ text: RECOGNIZED_TEXT, confidence: RECOGNIZED_CONFIDENCE_PERCENT, blocks: RECOGNIZED_BLOCKS })
    );
  });

  it('does not route a non-PDF OCR target to the edge OCR tier', () => {
    expect(routeByRules('png', 'txt', SCAN_WIDTH, { ocrEnabled: true }).tier).toBe('L4');
    expect(routeByRules('png', 'docx', SCAN_WIDTH, { ocrEnabled: true }).tier).toBe('L4');
    expect(routeByRules('png', 'pdf', SCAN_WIDTH, { ocrEnabled: true }).tier).toBe('L2');
  });

  it.each([
    ['routed by the tier rules', () => vi.mocked(resolveConversionTier).mockImplementation(routeByRules)],
    [
      'even when routed to L2',
      () =>
        vi.mocked(resolveConversionTier).mockReturnValue({
          tier: 'L2',
          tierName: 'Edge L2 (SIMD Wasm)',
          isClientEdge: true,
          reason: 'routed by test',
        }),
    ],
  ])('sends png to txt OCR to the cloud without running edge OCR, %s', async (_label, route) => {
    route();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      blob: async () => cloudBody,
    } as Response);
    const onSuccess = vi.fn();
    const onError = vi.fn();
    const item = { ...(await scanItem()), targetFormat: 'txt' };

    await executeItemConversion(item, { onProgress: () => undefined, onSuccess, onError });

    expect(createWorker).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/convert');
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const [, size, edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
    expect(size).toBe(cloudBody.size);
    expect(edgeProcessed).toBe(false);
    expect(tierName).toBe('Cloud (Zero-Retention)');
    expect(fallback).toBeUndefined();
  });
});
