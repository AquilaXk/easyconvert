import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '@/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '@/lib/types';
import { processGraphNodeJob } from '@/lib/queue/graph/node-executor';
import { s3Storage } from '@/lib/storage/s3-storage';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * What a graph node does for an attempt ends with the attempt: the qpdf run that opens an encrypted PDF, the merge of PDFs and the 7z
 * packer are given the signal of the attempt, so a job that is cancelled or past its deadline does not leave them running. An archive
 * node writes a .tar.gz with the compression level of its options, as every other route to the format does, without holding the
 * event loop while it compresses.
 */

const captured = vi.hoisted(() => ({ decrypt: [] as Array<AbortSignal | undefined>, merge: [] as Array<AbortSignal | undefined>, sevenZip: [] as Array<AbortSignal | undefined> }));

vi.mock('@/worker/pdf-decrypt', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/worker/pdf-decrypt')>();
  return {
    ...original,
    decryptPdfToBuffer: (request: Parameters<typeof original.decryptPdfToBuffer>[0]) => {
      captured.decrypt.push(request.signal);
      return original.decryptPdfToBuffer(request);
    },
  };
});
vi.mock('@/lib/jobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/jobs')>();
  return {
    ...original,
    mergePdfBuffers: (buffers: Buffer[], access?: { signal?: AbortSignal }) => {
      captured.merge.push(access?.signal);
      return original.mergePdfBuffers(buffers, access);
    },
  };
});
vi.mock('@/lib/conversions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/conversions')>();
  return {
    ...original,
    create7zArchiveAsync: (files: never, options: never, name: string, runtime?: { signal?: AbortSignal }) => {
      captured.sevenZip.push(runtime?.signal);
      return original.create7zArchiveAsync(files, options, name, runtime);
    },
  };
});

const TTL_MS = 60 * 60 * 1000;
const GZIP_FLAGS_BYTE = 8;
/** RFC 1952 section 2.3.1: the extra flags byte is 2 for the best compression (level 9) and 4 for the fastest (level 1). */
const GZIP_BEST = 2;
const GZIP_FASTEST = 4;
const qpdfMissing = skipWithoutTools('qpdf');

let graphSeq = 0;

function nodeJob(graphNode: Record<string, unknown>, inputArtifacts: string[], controller = new AbortController()) {
  graphSeq += 1;
  const graphId = `g_signal_${Date.now()}_${graphSeq}`;
  return {
    id: `${graphId}:n1`,
    data: { jobId: `${graphId}:n1`, sourceFormat: 'bin', targetFormat: 'bin', fileSize: 0, options: {}, graphId, graphNodeId: 'n1', graphNode, inputArtifacts },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: controller.signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

function seed(name: string, buffer: Buffer, mimeType: string): string {
  const key = `tests/graph-node-attempt-signal/${Date.now()}_${graphSeq}_${name}`;
  s3Storage.saveObject(key, buffer, mimeType, name, TTL_MS);
  return key;
}

async function pdfOf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let page = 1; page <= pages; page++) doc.addPage([200, 200]).drawText(`page ${page}`, { x: 10, y: 10 });
  return Buffer.from(await doc.save());
}

/** A PDF that opens with the empty password and forbids editing, written by qpdf: the node asks qpdf which rights the password grants. */
function ownerLocked(plain: Buffer): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-signal-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), plain);
    execFileSync('qpdf', ['--encrypt', '', 'owner-secret-1', '256', '--modify=none', '--', path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
    return fs.readFileSync(path.join(dir, 'out.pdf'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the signal of the attempt reaches the work of a node', () => {
  it.skipIf(qpdfMissing)('that opens an encrypted PDF', async () => {
    const controller = new AbortController();
    captured.decrypt.length = 0;
    const input = seed('locked.pdf', ownerLocked(await pdfOf(3)), 'application/pdf');
    await processGraphNodeJob(nodeJob({ op: 'pdf.extract-pages', options: { pages: '1', confirmEditRights: true } }, [input], controller), undefined, s3Storage);
    expect(captured.decrypt).toHaveLength(1);
    controller.abort();
    expect(captured.decrypt[0]?.aborted).toBe(true);
  });

  it('that merges PDFs', async () => {
    const controller = new AbortController();
    captured.merge.length = 0;
    const inputs = [seed('a.pdf', await pdfOf(1), 'application/pdf'), seed('b.pdf', await pdfOf(1), 'application/pdf')];
    await processGraphNodeJob(nodeJob({ op: 'merge', targetFormat: 'pdf' }, inputs, controller), undefined, s3Storage);
    expect(captured.merge[0]).toBe(controller.signal);
  });

  it('that packs a 7z archive', async () => {
    const controller = new AbortController();
    captured.sevenZip.length = 0;
    const input = seed('a.txt', Buffer.from('alpha'), 'text/plain');
    await processGraphNodeJob(nodeJob({ op: 'archive.create', targetFormat: '7z' }, [input], controller), undefined, s3Storage);
    expect(captured.sevenZip[0]).toBe(controller.signal);
  });
});

describe('a .tar.gz archive node', () => {
  async function gzipFlags(compressionLevel: number | undefined): Promise<number> {
    const input = seed('big.txt', Buffer.alloc(64 * 1024, 'compressible text '), 'text/plain');
    const options = compressionLevel === undefined ? undefined : { compressionLevel };
    const result = await processGraphNodeJob(nodeJob({ op: 'archive.create', targetFormat: 'tar.gz', ...(options ? { options } : {}) }, [input]), undefined, s3Storage);
    return s3Storage.getObject(result.resultKey)!.buffer[GZIP_FLAGS_BYTE];
  }

  it('is compressed at the level of its options', async () => {
    expect(await gzipFlags(9)).toBe(GZIP_BEST);
    expect(await gzipFlags(1)).toBe(GZIP_FASTEST);
  });

  it('refuses a level outside the range, as the other archive formats do', async () => {
    await expect(gzipFlags(99)).rejects.toThrow(/compressionLevel/);
  });
});
