import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult, ConversionOptions } from '@/lib/types';
import { UnsupportedOptionError } from '@/lib/types';
import type { ConversionEnginePort, EngineResult } from '@/lib/queue/engine-port';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * A thumbnail task shows one picture for each input, whatever the input is: the first page (or the page named) of a document, a
 * frame of a video, the picture itself, within width x height as `fit` places it, as JPEG, PNG or WebP.
 */

const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 200;
const EDGE = 64;

let seq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  seq += 1;
  const graphId = `g_thumb_${Date.now()}_${seq}`;
  return {
    id: `${graphId}:n1`,
    data: { jobId: `${graphId}:n1`, sourceFormat: 'bin', targetFormat: 'bin', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode, inputArtifacts },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

function seed(name: string, buffer: Buffer, mimeType: string): string {
  const key = `tests/thumbnail-task/${Date.now()}_${seq}_${name}`;
  s3Storage.saveObject(key, buffer, mimeType, name, ARTIFACT_TTL_MS);
  return key;
}

const sourcePng = (): Promise<Buffer> =>
  sharp({ create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 200, g: 40, b: 90 } } }).png().toBuffer();

function output(key: string): Buffer {
  const stored = s3Storage.getObject(key);
  if (!stored) throw new Error(`Output "${key}" is missing`);
  return stored.buffer;
}

interface Call {
  src: string;
  tgt: string;
  options: ConversionOptions;
}

/** An engine that records each conversion and answers with a PNG of the size the options ask for. */
function recordingEngine(calls: Call[]): ConversionEnginePort {
  return {
    name: 'recording',
    async convert(input, src, tgt, options): Promise<EngineResult> {
      calls.push({ src, tgt, options });
      const buffer = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } })[tgt === 'png' ? 'png' : 'jpeg']().toBuffer();
      return { buffer, size: buffer.length, mimeType: `image/${tgt}`, filename: `out.${tgt}` } as EngineResult;
    },
  };
}

describe('thumbnail task', () => {
  it.each([
    ['inside', EDGE, Math.round((EDGE * SOURCE_HEIGHT) / SOURCE_WIDTH)],
    ['cover', EDGE, EDGE],
    ['contain', EDGE, EDGE],
    ['fill', EDGE, EDGE],
  ] as const)('writes a WebP of %s fit at %i x %i from a PNG', async (fit, width, height) => {
    const input = seed('photo.png', await sourcePng(), 'image/png');
    const result = await processGraphNodeJob(
      nodeJob({ op: 'thumbnail', targetFormat: 'webp', options: { thumbnail: { width: EDGE, height: EDGE, fit } } }, [input]),
      undefined,
      s3Storage
    );
    expect(result.filename).toBe('thumbnail.webp');
    expect(result.mimeType).toBe('image/webp');
    const meta = await sharp(output(result.resultKey)).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([width, height]);
  });

  it('renders the first page of a document as a PNG and scales that picture, and renders the page the task names', async () => {
    const calls: Call[] = [];
    const doc = seed('doc.pdf', Buffer.from('%PDF-1.4 stand-in'), 'application/pdf');
    await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'png' }, [doc]), recordingEngine(calls), s3Storage);
    await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'jpg', options: { thumbnail: { page: 3, width: 100, height: 120, fit: 'cover' } } }, [doc]), recordingEngine(calls), s3Storage);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ src: 'pdf', tgt: 'png', options: { multiPageOutput: 'first' } });
    expect(calls[0].options.page).toBeUndefined();
    expect(calls[1]).toMatchObject({ src: 'png', tgt: 'png', options: { width: 256, height: 256, fit: 'inside' } });
    expect(calls[2]).toMatchObject({ src: 'pdf', tgt: 'png', options: { page: 3, multiPageOutput: 'first' } });
    expect(calls[3]).toMatchObject({ src: 'png', tgt: 'jpg', options: { width: 100, height: 120, fit: 'cover' } });
    expect(calls[3].options.page).toBeUndefined();
  });

  it('converts a picture in one step, with the page or frame the task names', async () => {
    const calls: Call[] = [];
    const gif = seed('anim.gif', Buffer.from('GIF89a stand-in'), 'image/gif');
    await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'webp', options: { thumbnail: { page: 2, width: 40, height: 40 } } }, [gif]), recordingEngine(calls), s3Storage);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ src: 'gif', tgt: 'webp', options: { width: 40, height: 40, fit: 'inside', page: 2, multiPageOutput: 'first' } });
  });

  it('takes the frame of a video as a PNG first and scales that picture to the target', async () => {
    const calls: Call[] = [];
    const video = seed('clip.mp4', Buffer.from('stand-in video'), 'video/mp4');
    const result = await processGraphNodeJob(
      nodeJob({ op: 'thumbnail', targetFormat: 'webp', options: { thumbnail: { at: ['00:00:03.000'], width: 90, height: 60, fit: 'contain', accurate: true } } }, [video]),
      recordingEngine(calls),
      s3Storage
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ src: 'mp4', tgt: 'png', options: { thumbnail: { at: ['00:00:03.000'], format: 'png', accurate: true } } });
    expect(calls[1]).toMatchObject({ src: 'png', tgt: 'webp', options: { width: 90, height: 60, fit: 'contain' } });
    expect(calls[1].options.thumbnail).toBeUndefined();
    expect(result.filename).toBe('thumbnail.webp');
  });

  it('uses the default frame time of a video that names none', async () => {
    const calls: Call[] = [];
    const video = seed('clip.mov', Buffer.from('stand-in video'), 'video/quicktime');
    await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'jpg' }, [video]), recordingEngine(calls), s3Storage);
    expect(calls[0].options.thumbnail?.at).toEqual(['00:00:01.000']);
  });

  it('refuses more than one frame: a thumbnail task makes one picture for each input', async () => {
    const video = seed('clip.mp4', Buffer.from('stand-in video'), 'video/mp4');
    const run = processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'png', options: { thumbnail: { at: ['1', '2'] } } }, [video]), recordingEngine([]), s3Storage);
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/one frame/);
  });

  it('refuses a target outside JPEG, PNG and WebP', async () => {
    const input = seed('photo.png', await sourcePng(), 'image/png');
    await expect(processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'gif' }, [input]), undefined, s3Storage)).rejects.toThrow(/cannot produce "gif"/);
  });

  it('makes one thumbnail for each of several inputs', async () => {
    const first = seed('a.png', await sourcePng(), 'image/png');
    const second = seed('b.png', await sourcePng(), 'image/png');
    const result = await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'jpg', options: { thumbnail: { width: EDGE, height: EDGE } } }, [first, second]), undefined, s3Storage);
    expect(result.resultKey).toMatch(/\/n1\/0\/thumbnail\.jpg$/);
  });
});

describe.skipIf(skipWithoutTools('pdftoppm'))('thumbnail task on a real PDF', () => {
  it('draws page 1 of a two-page PDF whose pages differ in size, and page 2 when the task names it', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 200]).drawText('first', { x: 20, y: 20 });
    doc.addPage([200, 400]).drawText('second', { x: 20, y: 20 });
    const input = seed('two.pdf', Buffer.from(await doc.save()), 'application/pdf');

    const first = await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'png', options: { thumbnail: { width: 100, height: 100 } } }, [input]), undefined, s3Storage);
    const firstMeta = await sharp(output(first.resultKey)).metadata();
    expect([firstMeta.format, firstMeta.width, firstMeta.height]).toEqual(['png', 100, 50]);

    const second = await processGraphNodeJob(nodeJob({ op: 'thumbnail', targetFormat: 'webp', options: { thumbnail: { width: 100, height: 100, page: 2 } } }, [input]), undefined, s3Storage);
    const secondMeta = await sharp(output(second.resultKey)).metadata();
    expect([secondMeta.format, secondMeta.width, secondMeta.height]).toEqual(['webp', 50, 100]);
  });
});
