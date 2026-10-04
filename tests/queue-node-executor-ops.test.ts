import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';
import { ConversionFailedError } from '@/lib/types';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';

const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const FIRST_PAGE_SIZE: [number, number] = [400, 400];
const SECOND_PAGE_SIZE: [number, number] = [300, 500];
const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 200;
const THUMB_EDGE = 64;
const JPEG_SOI = [0xff, 0xd8, 0xff];

let graphSeq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  graphSeq += 1;
  const graphId = `g_ops_${Date.now()}_${graphSeq}`;
  const job = {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'bin',
      targetFormat: 'bin',
      fileSize: 0,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode,
      inputArtifacts,
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
  return job;
}

function seed(name: string, buffer: Buffer, mimeType: string): string {
  const key = `tests/queue-node-executor-ops/${Date.now()}_${graphSeq}_${name}`;
  s3Storage.saveObject(key, buffer, mimeType, name, ARTIFACT_TTL_MS);
  return key;
}

async function singlePagePdf(size: [number, number], text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage(size).drawText(text, { x: 20, y: 20 });
  return Buffer.from(await doc.save());
}

async function sourcePng(): Promise<Buffer> {
  return sharp({
    create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    .png()
    .toBuffer();
}

function storedOutput(resultKey: string): Buffer {
  const stored = s3Storage.getObject(resultKey);
  if (!stored) throw new Error(`Output artifact "${resultKey}" missing from storage`);
  return stored.buffer;
}

describe('queue node executor operations', () => {
  describe('merge', () => {
    it('merges two PDFs into one document with pages in input order', async () => {
      const first = seed('a.pdf', await singlePagePdf(FIRST_PAGE_SIZE, 'A'), 'application/pdf');
      const second = seed('b.pdf', await singlePagePdf(SECOND_PAGE_SIZE, 'B'), 'application/pdf');

      const result = await processGraphNodeJob(
        nodeJob({ op: 'merge', targetFormat: 'pdf' }, [first, second]),
        undefined,
        s3Storage
      );

      expect(result.resultKey).toMatch(/\/n1\/merged\.pdf$/);
      const merged = storedOutput(result.resultKey);
      expect(merged.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      const doc = await PDFDocument.load(merged);
      const sizes = doc.getPages().map((page) => {
        const { width, height } = page.getSize();
        return [width, height];
      });
      expect(sizes).toEqual([FIRST_PAGE_SIZE, SECOND_PAGE_SIZE]);
    });

    it('rejects a missing input artifact', async () => {
      await expect(
        processGraphNodeJob(nodeJob({ op: 'merge', targetFormat: 'pdf' }, ['tests/none/missing.pdf']), undefined, s3Storage)
      ).rejects.toThrow(/Input artifact "tests\/none\/missing\.pdf" not found in storage/);
    });

    it('rejects an input whose format differs from the target format', async () => {
      const pdf = seed('a.pdf', await singlePagePdf(FIRST_PAGE_SIZE, 'A'), 'application/pdf');
      const txt = seed('notes.txt', Buffer.from('plain text', 'utf-8'), 'text/plain');
      const run = processGraphNodeJob(nodeJob({ op: 'merge', targetFormat: 'pdf' }, [pdf, txt]), undefined, s3Storage);
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/received a "txt" input; expected "pdf"/);
    });

    it('rejects a zero-byte PDF input with a typed error', async () => {
      const pdf = seed('a.pdf', await singlePagePdf(FIRST_PAGE_SIZE, 'A'), 'application/pdf');
      const empty = seed('empty.pdf', Buffer.alloc(0), 'application/pdf');
      const run = processGraphNodeJob(nodeJob({ op: 'merge', targetFormat: 'pdf' }, [pdf, empty]), undefined, s3Storage);
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/is empty/);
    });
  });

  describe('thumbnail', () => {
    it('renders a PNG into a JPEG thumbnail within the requested bounds', async () => {
      const png = seed('photo.png', await sourcePng(), 'image/png');

      const result = await processGraphNodeJob(
        nodeJob(
          { op: 'thumbnail', targetFormat: 'jpg', options: { thumbnail: { width: THUMB_EDGE, height: THUMB_EDGE } } },
          [png]
        ),
        undefined,
        s3Storage
      );

      expect(result.resultKey).toMatch(/\/n1\/thumbnail\.jpg$/);
      const thumb = storedOutput(result.resultKey);
      expect([...thumb.subarray(0, JPEG_SOI.length)]).toEqual(JPEG_SOI);
      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      expect(meta.width!).toBeLessThanOrEqual(THUMB_EDGE);
      expect(meta.height!).toBeLessThanOrEqual(THUMB_EDGE);
    });

    it('rejects a target format outside the thumbnail formats', async () => {
      const png = seed('photo.png', await sourcePng(), 'image/png');
      const run = processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'webp' }, [png]), undefined, s3Storage);
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/cannot produce "webp"/);
    });
  });

  describe('metadata', () => {
    it('writes metadata.json whose dimensions match the source image', async () => {
      const source = await sourcePng();
      const sourceMeta = await sharp(source).metadata();
      const png = seed('photo.png', source, 'image/png');

      const result = await processGraphNodeJob(nodeJob({ op: 'metadata' }, [png]), undefined, s3Storage);

      expect(result.resultKey).toMatch(/\/n1\/metadata\.json$/);
      const parsed = JSON.parse(storedOutput(result.resultKey).toString('utf-8'));
      expect(parsed).toMatchObject({
        format: 'png',
        sizeBytes: source.length,
        width: sourceMeta.width,
        height: sourceMeta.height,
      });
      expect(parsed.width).toBe(SOURCE_WIDTH);
      expect(parsed.height).toBe(SOURCE_HEIGHT);
    });
  });

  describe('unknown operations', () => {
    it.each(['bogus', 'archive/create'])('rejects %s', async (op) => {
      const png = seed('photo.png', await sourcePng(), 'image/png');
      await expect(processGraphNodeJob(nodeJob({ op }, [png]), undefined, s3Storage)).rejects.toThrow(
        new RegExp(`Unsupported graph node operation: ${op.replace('/', '\\/')}`)
      );
    });
  });
});
