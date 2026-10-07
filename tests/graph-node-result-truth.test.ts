import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';
import { ConversionFailedError, UnknownArtifactFormatError, WorkerOutputMissingError } from '@/lib/types';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';

/**
 * Issue #484: a completed graph node reported `application/octet-stream` and `size: 0` for every output.
 * The expected MIME types below are written by hand from the IANA media type registrations, not read from
 * the format registry; the expected sizes are the byte lengths of the objects actually held in storage.
 */

const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const SOURCE_WIDTH = 320;
const SOURCE_HEIGHT = 200;
const THUMB_EDGE = 64;

const EXPECTED_MIME = {
  jpg: 'image/jpeg',
  png: 'image/png',
  zip: 'application/zip',
  targz: 'application/gzip',
  json: 'application/json',
  pdf: 'application/pdf',
  txt: 'text/plain',
  opaque: 'application/octet-stream',
} as const;

let graphSeq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[]) {
  graphSeq += 1;
  const graphId = `g_truth_${Date.now()}_${graphSeq}`;
  return {
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
}

function seed(name: string, buffer: Buffer, mimeType: string): string {
  const key = `tests/graph-node-result-truth/${Date.now()}_${graphSeq}_${name}`;
  s3Storage.saveObject(key, buffer, mimeType, name, ARTIFACT_TTL_MS);
  return key;
}

function stored(key: string) {
  const object = s3Storage.getObject(key);
  if (!object) throw new Error(`Output artifact "${key}" missing from storage`);
  return object;
}

async function sourcePng(): Promise<Buffer> {
  return sharp({
    create: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
}

async function singlePagePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]).drawText(text, { x: 10, y: 10 });
  return Buffer.from(await doc.save());
}

async function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('graph node results report the stored output', () => {
  it('reports the JPEG MIME type and exact byte size of a thumbnail', async () => {
    const png = seed('photo.png', await sourcePng(), 'image/png');

    const result = await processGraphNodeJob(
      nodeJob({ op: 'thumbnail', targetFormat: 'jpg', options: { thumbnail: { width: THUMB_EDGE, height: THUMB_EDGE } } }, [png]),
      undefined,
      s3Storage
    );

    const output = stored(result.resultKey);
    expect(result.mimeType).toBe(EXPECTED_MIME.jpg);
    expect(output.mimeType).toBe(EXPECTED_MIME.jpg);
    expect(result.size).toBe(output.buffer.length);
    expect(result.size).toBeGreaterThan(0);
  });

  it('reports the ZIP MIME type and exact byte size of a created archive', async () => {
    const a = seed('a.txt', Buffer.from('alpha', 'utf-8'), 'text/plain');
    const b = seed('b.txt', Buffer.from('beta beta', 'utf-8'), 'text/plain');

    const result = await processGraphNodeJob(nodeJob({ op: 'archive.create', targetFormat: 'zip' }, [a, b]), undefined, s3Storage);

    const output = stored(result.resultKey);
    expect(result.resultKey).toMatch(/\/n1\/bundle\.zip$/);
    expect(result.mimeType).toBe(EXPECTED_MIME.zip);
    expect(output.mimeType).toBe(EXPECTED_MIME.zip);
    expect(result.size).toBe(output.buffer.length);
    // ZIP local file header magic: the reported size belongs to a real archive, not a placeholder.
    expect(output.buffer.subarray(0, 4).toString('hex')).toBe('504b0304');
  });

  it('reports the gzip MIME type of a tar.gz archive', async () => {
    const a = seed('a.txt', Buffer.from('alpha', 'utf-8'), 'text/plain');

    const result = await processGraphNodeJob(nodeJob({ op: 'archive.create', targetFormat: 'tar.gz' }, [a]), undefined, s3Storage);

    const output = stored(result.resultKey);
    expect(result.mimeType).toBe(EXPECTED_MIME.targz);
    expect(output.mimeType).toBe(EXPECTED_MIME.targz);
    expect(result.size).toBe(output.buffer.length);
    expect(output.buffer.subarray(0, 2).toString('hex')).toBe('1f8b');
  });

  it('reports the JSON MIME type of a metadata artifact', async () => {
    const png = seed('photo.png', await sourcePng(), 'image/png');

    const result = await processGraphNodeJob(nodeJob({ op: 'metadata' }, [png]), undefined, s3Storage);

    const output = stored(result.resultKey);
    expect(result.mimeType).toBe(EXPECTED_MIME.json);
    expect(output.mimeType).toBe(EXPECTED_MIME.json);
    expect(result.size).toBe(output.buffer.length);
  });

  it('reports the PDF MIME type of a merged document', async () => {
    const first = seed('a.pdf', await singlePagePdf('A'), 'application/pdf');
    const second = seed('b.pdf', await singlePagePdf('B'), 'application/pdf');

    const result = await processGraphNodeJob(nodeJob({ op: 'merge', targetFormat: 'pdf' }, [first, second]), undefined, s3Storage);

    expect(result.mimeType).toBe(EXPECTED_MIME.pdf);
    expect(result.size).toBe(stored(result.resultKey).buffer.length);
  });

  it('names the registry MIME type of an imported upload whose stored type is the generic binary type', async () => {
    const bytes = await sourcePng();
    const key = seed('upload.png', bytes, 'application/octet-stream');

    const result = await processGraphNodeJob(nodeJob({ op: 'import.upload', storageKey: key }, []), undefined, s3Storage);

    expect(result.resultKey).toBe(key);
    expect(result.mimeType).toBe(EXPECTED_MIME.png);
    expect(result.size).toBe(bytes.length);
  });

  describe('archive.extract', () => {
    it('saves each extracted entry with the MIME type of its format and reports the first one', async () => {
      const archive = seed('bundle.zip', await zipOf({ 'notes.txt': 'extracted text body' }), 'application/zip');

      const result = await processGraphNodeJob(nodeJob({ op: 'archive.extract' }, [archive]), undefined, s3Storage);

      const output = stored(result.resultKey);
      expect(output.buffer.toString('utf-8')).toBe('extracted text body');
      expect(output.mimeType).toBe(EXPECTED_MIME.txt);
      expect(result.mimeType).toBe(EXPECTED_MIME.txt);
      expect(result.size).toBe(Buffer.byteLength('extracted text body', 'utf-8'));
    });

    it.each(['LICENSE', 'blob.zzunknown'])(
      'stores entry %s, whose name has no registered format, as opaque binary instead of failing the node',
      async (entryName) => {
        const archive = seed('bundle.zip', await zipOf({ [entryName]: 'opaque entry body' }), 'application/zip');

        const result = await processGraphNodeJob(nodeJob({ op: 'archive.extract' }, [archive]), undefined, s3Storage);

        const output = stored(result.resultKey);
        expect(output.filename).toBe(entryName);
        expect(output.buffer.toString('utf-8')).toBe('opaque entry body');
        expect(output.mimeType).toBe(EXPECTED_MIME.opaque);
        expect(result.mimeType).toBe(EXPECTED_MIME.opaque);
        expect(result.size).toBe(Buffer.byteLength('opaque entry body', 'utf-8'));
      }
    );
  });

  it('still fails closed on a node output whose format the registry does not know', async () => {
    const key = seed('upload.zzunknown', Buffer.from('opaque'), 'application/octet-stream');
    const run = processGraphNodeJob(nodeJob({ op: 'import.upload', storageKey: key }, []), undefined, s3Storage);

    await expect(run).rejects.toBeInstanceOf(UnknownArtifactFormatError);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow('has no format registered, so its MIME type is unknown');
  });

  it('fails with WorkerOutputMissingError when the node output is not in storage', async () => {
    const run = processGraphNodeJob(
      nodeJob({ op: 'import.upload', storageKey: 'tests/graph-node-result-truth/never-stored.png' }, []),
      undefined,
      s3Storage
    );

    await expect(run).rejects.toBeInstanceOf(WorkerOutputMissingError);
    await expect(run).rejects.toThrow('The persisted conversion output "never-stored.png" is no longer available');
  });
});
