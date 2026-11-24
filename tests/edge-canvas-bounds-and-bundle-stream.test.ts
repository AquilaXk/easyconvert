import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import AdmZip from 'adm-zip';
import JSZip from 'jszip';

import {
  MAX_BROWSER_CANVAS_PIXELS,
  MAX_BROWSER_CANVAS_SIDE,
  assertBrowserCanvasDimensions,
  assertCanvasInputSupported,
} from '../src/lib/edge/pure/canvas-header-guard';
import { convertPureCanvas } from '../src/lib/edge/pure/pure-canvas';
import { tryProcessClientEdge } from '../src/lib/client-converter';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import type { ConversionQueueItem } from '../src/lib/types';
import {
  BUNDLE_TICKET_TTL_SECONDS,
  MAX_LOCAL_BUNDLE_TICKETS,
  consumeBundleTicket,
  createBundleTicket,
  resetLocalBundleTicketsForTests,
} from '../src/lib/storage/bundle-ticket-store';
import { GET as bundleGet, POST as bundlePost } from '../src/app/api/storage/bundle/route';
import {
  MAX_IN_MEMORY_ZIP_BYTES,
  MAX_OPFS_ZIP_BYTES,
  downloadZipStream,
  materializeZipStreamUrl,
  triggerAnchorDownload,
} from '../src/lib/download-blob';
import { createDownloadAllZipHandler, type QueueMutationContext } from '../src/hooks/useClientQueue';
import { releaseEdgeResultResources } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';
import { streamZipReadable } from '../src/lib/archive/streaming-zip';
import { storageProvider } from '../src/lib/storage';
import * as retentionMod from '../src/lib/storage/retention-service';
import { getRetentionLedger } from '../src/lib/storage/retention-ledger';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { createSessionToken } from '../src/lib/auth/session';
import * as concurrencyLimitMod from '../src/lib/queue/concurrency-limit';

function buildPngHeader(
  width: number,
  height: number,
  options: {
    bitDepth?: number;
    preIdatPaddingChunks?: number;
    preIdatChunkPayloadBytes?: number;
    includeIdat?: boolean;
    includeIend?: boolean;
    trailingIend?: boolean;
    extraChunk?: { tag: string; payload: Uint8Array };
  } = {}
): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Uint8Array[] = [sig];

  const makeChunk = (tag: string, payload: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + payload.length);
    new DataView(out.buffer).setUint32(0, payload.length, false);
    out[4] = tag.charCodeAt(0);
    out[5] = tag.charCodeAt(1);
    out[6] = tag.charCodeAt(2);
    out[7] = tag.charCodeAt(3);
    out.set(payload, 8);
    return out;
  };

  const ihdrPayload = new Uint8Array(13);
  const ihdrView = new DataView(ihdrPayload.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrPayload[8] = options.bitDepth ?? 8;
  ihdrPayload[9] = 6;
  parts.push(makeChunk('IHDR', ihdrPayload));

  if (options.extraChunk) {
    parts.push(makeChunk(options.extraChunk.tag, options.extraChunk.payload));
  }

  const padCount = options.preIdatPaddingChunks ?? 0;
  const padBytes = options.preIdatChunkPayloadBytes ?? 0;
  for (let i = 0; i < padCount; i++) {
    parts.push(makeChunk('pHYs', new Uint8Array(padBytes)));
  }

  if (options.includeIdat !== false) {
    parts.push(makeChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])));
  }

  if (options.includeIend !== false) {
    parts.push(makeChunk('IEND', new Uint8Array(0)));
  }

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const res = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    res.set(p, offset);
    offset += p.length;
  }
  return res;
}

function buildGifWithGeometry(lsdW: number, lsdH: number, frame?: { left: number; top: number; w: number; h: number }): Uint8Array {
  const f = frame ?? { left: 0, top: 0, w: Math.min(lsdW, 10), h: Math.min(lsdH, 10) };
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  view.setUint16(6, lsdW, true);
  view.setUint16(8, lsdH, true);
  out[13] = 0x2c;
  view.setUint16(14, f.left, true);
  view.setUint16(16, f.top, true);
  view.setUint16(18, f.w, true);
  view.setUint16(20, f.h, true);
  out[23] = 0x02;
  out[24] = 0x01;
  out[25] = 0x00;
  out[26] = 0x00;
  out[27] = 0x3b;
  return out;
}

function buildWebpVp8x(width: number, height: number, flags = 0): Uint8Array {
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set([0x56, 0x50, 0x38, 0x58], 12);
  view.setUint32(16, 10, true);
  out[20] = flags;
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  out[24] = wMinus1 & 0xff;
  out[25] = (wMinus1 >> 8) & 0xff;
  out[26] = (wMinus1 >> 16) & 0xff;
  out[27] = hMinus1 & 0xff;
  out[28] = (hMinus1 >> 8) & 0xff;
  out[29] = (hMinus1 >> 16) & 0xff;
  return out;
}

function buildWebpVp8(width: number, height: number): Uint8Array {
  const out = new Uint8Array(30);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 22, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set([0x56, 0x50, 0x38, 0x20], 12);
  view.setUint32(16, 10, true);
  out[20] = 0x00;
  out[23] = 0x9d;
  out[24] = 0x01;
  out[25] = 0x2a;
  view.setUint16(26, width & 0x3fff, true);
  view.setUint16(28, height & 0x3fff, true);
  return out;
}

function buildWebpVp8l(width: number, height: number): Uint8Array {
  const out = new Uint8Array(26);
  const view = new DataView(out.buffer);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  view.setUint32(4, 18, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  out.set([0x56, 0x50, 0x38, 0x4c], 12);
  view.setUint32(16, 5, true);
  out[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  view.setUint32(21, bits >>> 0, true);
  return out;
}

function buildJpegWithSof(width: number, height: number, options: { preSofPaddingBytes?: number; includeSos?: boolean } = {}): Uint8Array {
  const segments: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  let remainingPad = options.preSofPaddingBytes ?? 0;
  while (remainingPad > 0) {
    const payloadLen = Math.min(remainingPad, 60_000);
    const segLen = payloadLen + 2;
    const com = new Uint8Array(2 + segLen);
    com[0] = 0xff;
    com[1] = 0xfe;
    com[2] = (segLen >> 8) & 0xff;
    com[3] = segLen & 0xff;
    segments.push(com);
    remainingPad -= payloadLen;
  }

  const sof = new Uint8Array(19);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof[2] = 0x00;
  sof[3] = 17;
  sof[4] = 8;
  sof[5] = (height >> 8) & 0xff;
  sof[6] = height & 0xff;
  sof[7] = (width >> 8) & 0xff;
  sof[8] = width & 0xff;
  sof[9] = 3;
  segments.push(sof);

  if (options.includeSos !== false) {
    segments.push(new Uint8Array([0xff, 0xda, 0x00, 0x08, 1, 1, 0, 0, 63, 0, 0xff, 0xd9]));
  } else {
    segments.push(new Uint8Array([0xff, 0xd9]));
  }

  const total = segments.reduce((acc, s) => acc + s.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const s of segments) {
    out.set(s, pos);
    pos += s.length;
  }
  return out;
}

function buildBmpHeader(width: number, height: number, dibSize: 12 | 40 = 40): Uint8Array {
  const out = new Uint8Array(14 + dibSize);
  const view = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  view.setUint32(14, dibSize, true);
  if (dibSize === 12) {
    view.setUint16(18, width, true);
    view.setUint16(20, height, true);
  } else {
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
  }
  return out;
}

function createFakeOpfsRoot() {
  const dirs = new Map<string, Map<string, Uint8Array>>();
  const removedSessions: string[] = [];

  const getSessionFiles = (sessionId: string): Map<string, Uint8Array> => {
    let files = dirs.get(sessionId);
    if (!files) {
      files = new Map();
      dirs.set(sessionId, files);
    }
    return files;
  };

  const makeSessionDirHandle = (sessionId: string) => ({
    kind: 'directory',
    name: sessionId,
    async getFileHandle(name: string) {
      const files = getSessionFiles(sessionId);
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      let aborted = false;
      return {
        kind: 'file',
        name,
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            async write(data: BufferSource | Uint8Array) {
              const bytes =
                data instanceof Uint8Array
                  ? data
                  : ArrayBuffer.isView(data)
                    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                    : new Uint8Array(data);
              chunks.push(bytes.slice());
            },
            async close() {
              if (aborted) return;
              const total = chunks.reduce((n, c) => n + c.byteLength, 0);
              const out = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                out.set(c, off);
                off += c.byteLength;
              }
              files.set(name, out);
            },
            async abort() {
              aborted = true;
            },
          };
        },
        async getFile() {
          const bytes = files.get(name) ?? new Uint8Array(0);
          return new File([bytes as BlobPart], name, { type: 'application/zip' });
        },
      };
    },
    async removeEntry(name: string) {
      getSessionFiles(sessionId).delete(name);
    },
  });

  const sessionsDirHandle = {
    kind: 'directory',
    name: 'sessions',
    async getDirectoryHandle(sessionId: string, opts?: { create?: boolean }) {
      if (!opts?.create && !dirs.has(sessionId)) {
        throw new Error('NotFoundError');
      }
      getSessionFiles(sessionId);
      return makeSessionDirHandle(sessionId);
    },
    async removeEntry(sessionId: string) {
      removedSessions.push(sessionId);
      dirs.delete(sessionId);
    },
  };

  const easyconvertDirHandle = {
    kind: 'directory',
    name: 'easyconvert',
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      if (name !== 'sessions') throw new Error(`Unexpected dir ${name}`);
      if (!opts?.create && dirs.size === 0) return sessionsDirHandle;
      return sessionsDirHandle;
    },
  };

  const rootDir = {
    async getDirectoryHandle(name: string) {
      if (name !== 'easyconvert') throw new Error(`Unexpected root dir ${name}`);
      return easyconvertDirHandle;
    },
  };

  return { rootDir, dirs, removedSessions };
}

describe('P1-13: Canvas 2D pixel/side bounds, ImageBitmap cleanup, PNG tail metadata, and bundle streaming', () => {
  const createdStorageKeys: string[] = [];

  beforeEach(() => {
    resetLocalBundleTicketsForTests();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetLocalBundleTicketsForTests();
    while (createdStorageKeys.length > 0) {
      const key = createdStorageKeys.pop()!;
      await Promise.resolve(storageProvider.deleteObject(key)).catch(() => false);
      await getRetentionLedger().forget(key).catch(() => undefined);
    }
  });

  describe('1. Browser Canvas 2D pixel area & side caps + container header guards', () => {
    it('enforces MAX_BROWSER_CANVAS_SIDE (16384) and MAX_BROWSER_CANVAS_PIXELS (16,777,216)', () => {
      expect(MAX_BROWSER_CANVAS_SIDE).toBe(16_384);
      expect(MAX_BROWSER_CANVAS_PIXELS).toBe(16_777_216);

      assertBrowserCanvasDimensions(4096, 4096, 'Valid square');
      assertBrowserCanvasDimensions(16_384, 1024, 'Valid wide');
      assertBrowserCanvasDimensions(1024, 16_384, 'Valid tall');

      for (const [w, h] of [
        [0, 100],
        [100, 0],
        [-1, 100],
        [1.5, 100],
        [Number.POSITIVE_INFINITY, 10],
        [16_385, 1],
        [1, 16_385],
        [4097, 4096],
        [5000, 5000],
      ] as const) {
        expect(() => assertBrowserCanvasDimensions(w, h, 'Probe'), `${w}x${h}`).toThrow(EdgeUnsupportedError);
      }
    });

    it('rejects oversized GIF LSD, GIF frame descriptors, composite bounding boxes, and >65536 GIF blocks', async () => {
      await expect(assertCanvasInputSupported(buildGifWithGeometry(4097, 4096), 'gif', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(
        assertCanvasInputSupported(buildGifWithGeometry(100, 100, { left: 16_000, top: 0, w: 500, h: 10 }), 'gif', true)
      ).rejects.toThrow(EdgeUnsupportedError);
      await expect(
        assertCanvasInputSupported(buildGifWithGeometry(100, 100, { left: 0, top: 0, w: 4097, h: 4096 }), 'gif', true)
      ).rejects.toThrow(EdgeUnsupportedError);

      // 65,536 comment extensions before trailer
      const blockBomb = new Uint8Array(13 + 65_536 * 3 + 1);
      blockBomb.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], 0);
      for (let i = 0; i < 65_536; i++) {
        const off = 13 + i * 3;
        blockBomb[off] = 0x21;
        blockBomb[off + 1] = 0xfe;
        blockBomb[off + 2] = 0x00;
      }
      blockBomb[blockBomb.length - 1] = 0x3b;
      await expect(assertCanvasInputSupported(blockBomb, 'gif', true)).rejects.toThrow(EdgeUnsupportedError);

      // GIF87a oversized dimensions
      const gif87a = buildGifWithGeometry(5000, 5000);
      gif87a[4] = 0x37;
      await expect(assertCanvasInputSupported(gif87a, 'gif', true)).rejects.toThrow(EdgeUnsupportedError);

      // GIF single extension with 65,536 1-byte sub-blocks
      const subBlockBomb = new Uint8Array(13 + 2 + 65_536 * 2 + 2);
      subBlockBomb.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00], 0);
      subBlockBomb[13] = 0x21;
      subBlockBomb[14] = 0xfe;
      for (let i = 0; i < 65_536; i++) {
        const off = 15 + i * 2;
        subBlockBomb[off] = 1;
        subBlockBomb[off + 1] = 0x41;
      }
      subBlockBomb[subBlockBomb.length - 2] = 0x00;
      subBlockBomb[subBlockBomb.length - 1] = 0x3b;
      await expect(assertCanvasInputSupported(subBlockBomb, 'gif', true)).rejects.toThrow(EdgeUnsupportedError);
    });

    it('rejects oversized WebP VP8X, VP8, VP8L frames and excessive WebP chunks', async () => {
      await expect(assertCanvasInputSupported(buildWebpVp8x(5000, 5000), 'webp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildWebpVp8x(16_385, 1), 'webp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildWebpVp8(5000, 5000), 'webp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildWebpVp8l(5000, 5000), 'webp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await assertCanvasInputSupported(buildWebpVp8l(4096, 4096), 'webp', true);

      const webpBomb = new Uint8Array(12 + 65_536 * 8);
      const view = new DataView(webpBomb.buffer);
      webpBomb.set([0x52, 0x49, 0x46, 0x46], 0);
      view.setUint32(4, webpBomb.length - 8, true);
      webpBomb.set([0x57, 0x45, 0x42, 0x50], 8);
      for (let i = 0; i < 65_536; i++) {
        const off = 12 + i * 8;
        webpBomb.set([0x4a, 0x55, 0x4e, 0x4b], off); // JUNK
        view.setUint32(off + 4, 0, true);
      }
      await expect(assertCanvasInputSupported(webpBomb, 'webp', true)).rejects.toThrow(EdgeUnsupportedError);
    });

    it('rejects oversized PNGs, >1 MiB PNGs missing IEND when !stripMetadata, and >1 MiB pre-IDAT padding even when stripMetadata=true', async () => {
      await expect(assertCanvasInputSupported(buildPngHeader(4097, 4096), 'png', true)).rejects.toThrow(
        EdgeUnsupportedError
      );

      // > 1 MiB PNG where a single IDAT chunk extends past the 1 MiB window and IEND trails at the end
      const largePngTailPayload = new Uint8Array(1024 * 1024 + 64 * 1024);
      const headOnly = buildPngHeader(100, 100, { includeIdat: false, includeIend: false });
      largePngTailPayload.set(headOnly, 0);
      const idatLen = largePngTailPayload.length - headOnly.length - 12 - 12;
      const idatHeaderOffset = headOnly.length;
      new DataView(largePngTailPayload.buffer).setUint32(idatHeaderOffset, idatLen, false);
      largePngTailPayload[idatHeaderOffset + 4] = 0x49;
      largePngTailPayload[idatHeaderOffset + 5] = 0x44;
      largePngTailPayload[idatHeaderOffset + 6] = 0x41;
      largePngTailPayload[idatHeaderOffset + 7] = 0x54;
      largePngTailPayload.set(
        [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0, 0, 0, 0],
        largePngTailPayload.length - 12
      );

      const largePngBlob = new Blob([largePngTailPayload], { type: 'image/png' });
      await expect(assertCanvasInputSupported(largePngBlob, 'png', false)).rejects.toThrow(/post-IDAT metadata/);
      // With stripMetadata=true and IDAT already seen inside the 1 MiB window, allowed
      await assertCanvasInputSupported(largePngBlob, 'png', true);

      // > 1 MiB pre-IDAT padding (!sawIdat inside 1 MiB window) must escalate even with stripMetadata=true
      const paddedPreIdat = buildPngHeader(100, 100, {
        preIdatPaddingChunks: 20,
        preIdatChunkPayloadBytes: 60_000,
        includeIdat: true,
        includeIend: true,
      });
      expect(paddedPreIdat.byteLength).toBeGreaterThan(1024 * 1024);
      await expect(assertCanvasInputSupported(paddedPreIdat, 'png', true)).rejects.toThrow(/pre-IDAT header/);
    });

    it('rejects oversized JPEG, height=0 DNL JPEGs, missing SOF in 1 MiB, and missing SOS when !stripMetadata', async () => {
      await expect(assertCanvasInputSupported(buildJpegWithSof(5000, 5000), 'jpg', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildJpegWithSof(100, 0), 'jpg', true)).rejects.toThrow(
        EdgeUnsupportedError
      );

      // > 1 MiB JPEG with SOF beyond 1 MiB
      const paddedJpeg = buildJpegWithSof(100, 100, { preSofPaddingBytes: 1100 * 1024 });
      await expect(assertCanvasInputSupported(paddedJpeg, 'jpg', true)).rejects.toThrow(EdgeUnsupportedError);

      // > 1 MiB JPEG with SOF inside 1 MiB but SOS beyond 1 MiB (e.g. >1 MiB APPn padding after SOF):
      // fails when !stripMetadata, passes when stripMetadata=true
      const postSofPad = new Uint8Array(1200 * 1024);
      const smallSof = buildJpegWithSof(100, 100, { includeSos: false });
      postSofPad.set(smallSof.subarray(0, smallSof.length - 2), 0);
      let cur = smallSof.length - 2;
      while (cur + 60_004 < postSofPad.length - 16) {
        postSofPad[cur] = 0xff;
        postSofPad[cur + 1] = 0xfe;
        postSofPad[cur + 2] = (60_002 >> 8) & 0xff;
        postSofPad[cur + 3] = 60_002 & 0xff;
        cur += 60_004;
      }
      postSofPad[cur] = 0xff;
      postSofPad[cur + 1] = 0xda;
      postSofPad[cur + 2] = 0x00;
      postSofPad[cur + 3] = 0x08;
      postSofPad[postSofPad.length - 2] = 0xff;
      postSofPad[postSofPad.length - 1] = 0xd9;
      await expect(assertCanvasInputSupported(postSofPad, 'jpg', false)).rejects.toThrow(EdgeUnsupportedError);
      await assertCanvasInputSupported(postSofPad, 'jpg', true);

      // > 1 MiB JPEG with SOF + SOS inside 1 MiB passes even with !stripMetadata
      const largeStreamJpeg = new Uint8Array(1200 * 1024);
      const headJpeg = buildJpegWithSof(100, 100, { includeSos: true });
      largeStreamJpeg.set(headJpeg.subarray(0, headJpeg.length - 2), 0);
      largeStreamJpeg[largeStreamJpeg.length - 2] = 0xff;
      largeStreamJpeg[largeStreamJpeg.length - 1] = 0xd9;
      await assertCanvasInputSupported(largeStreamJpeg, 'jpg', false);
    });

    it('rejects oversized BMPs including BITMAPCOREHEADER, negative top-down heights, and INT32_MIN', async () => {
      await expect(assertCanvasInputSupported(buildBmpHeader(5000, 5000, 12), 'bmp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildBmpHeader(100, -16_385, 40), 'bmp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await expect(assertCanvasInputSupported(buildBmpHeader(100, -0x80000000, 40), 'bmp', true)).rejects.toThrow(
        EdgeUnsupportedError
      );
      await assertCanvasInputSupported(buildBmpHeader(100, -100, 40), 'bmp', true);
    });
  });

  describe('2. Deterministic ImageBitmap cleanup & geometry bounds across L0, L1A, and L2', () => {
    it('closes ImageBitmap in finally on L0 convertPureCanvas for oversized decoded image, oversized target resize, null ctx, and drawImage throw', async () => {
      let closeCount = 0;
      let offscreenAllocCount = 0;
      let ctxMode: 'ok' | 'null' | 'throwDraw' = 'ok';
      let decodedDims = { width: 5000, height: 5000 };

      vi.stubGlobal('createImageBitmap', async () => ({
        width: decodedDims.width,
        height: decodedDims.height,
        close: () => {
          closeCount += 1;
        },
      }));
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor(public width: number, public height: number) {
            offscreenAllocCount += 1;
          }
          getContext() {
            if (ctxMode === 'null') return null;
            return {
              fillStyle: '#fff',
              imageSmoothingEnabled: true,
              imageSmoothingQuality: 'high',
              fillRect: () => undefined,
              drawImage: () => {
                if (ctxMode === 'throwDraw') throw new Error('drawImage failed');
              },
              getImageData: (_x: number, _y: number, w: number, h: number) => ({
                width: w,
                height: h,
                data: new Uint8ClampedArray(w * h * 4),
              }),
            };
          }
        }
      );

      const smallPng = buildPngHeader(4, 4);

      // Oversized decoded bitmap: closes bitmap without allocating OffscreenCanvas
      await expect(convertPureCanvas(smallPng, 'png', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      expect(closeCount).toBe(1);
      expect(offscreenAllocCount).toBe(0);

      // Small bitmap resized to oversized target: closes bitmap without allocating OffscreenCanvas
      decodedDims = { width: 100, height: 100 };
      await expect(convertPureCanvas(smallPng, 'png', 'bmp', { width: 5000, height: 5000 })).rejects.toThrow(
        EdgeUnsupportedError
      );
      expect(closeCount).toBe(2);
      expect(offscreenAllocCount).toBe(0);

      // null getContext: closes bitmap
      ctxMode = 'null';
      await expect(convertPureCanvas(smallPng, 'png', 'bmp')).rejects.toThrow(EdgeUnsupportedError);
      expect(closeCount).toBe(3);

      // drawImage throw: closes bitmap
      ctxMode = 'throwDraw';
      await expect(convertPureCanvas(smallPng, 'png', 'bmp')).rejects.toThrow('drawImage failed');
      expect(closeCount).toBe(4);
    });

    it('closes ImageBitmap in finally and enforces pixel bounds on L1A and L2', async () => {
      let closeCount = 0;
      let offscreenAllocCount = 0;
      let ctxMode: 'ok' | 'null' | 'throwDraw' = 'ok';
      let decodedDims = { width: 5000, height: 5000 };

      vi.stubGlobal('window', globalThis);
      vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => null } });
      vi.stubGlobal('createImageBitmap', async () => ({
        width: decodedDims.width,
        height: decodedDims.height,
        close: () => {
          closeCount += 1;
        },
      }));
      vi.stubGlobal(
        'OffscreenCanvas',
        class {
          constructor(public width: number, public height: number) {
            offscreenAllocCount += 1;
          }
          getContext() {
            if (ctxMode === 'null') return null;
            return {
              drawImage: () => {
                if (ctxMode === 'throwDraw') throw new Error('drawImage failed');
              },
            };
          }
        }
      );

      const pngBytes = buildPngHeader(4, 4);
      const file = new File([pngBytes as BlobPart], 'in.png', { type: 'image/png' });

      // L1A oversized bitmap escalates as L1A and closes bitmap
      const l1aItem: ConversionQueueItem = {
        id: 'l1a-big',
        file,
        name: 'in.png',
        size: file.size,
        sourceFormat: 'png',
        targetFormat: 'webp',
        status: 'ready',
        progress: 0,
        options: { useWebGpu: true, blurRadius: 2 } as ConversionQueueItem['options'],
      };
      await expect(tryProcessClientEdge(l1aItem)).rejects.toMatchObject({
        name: 'ClientEdgeEscalationError',
        fallbackFrom: 'L1A',
      });
      expect(closeCount).toBe(1);
      expect(offscreenAllocCount).toBe(0);

      // L1A null ctx falls back to L2 (which also gets null ctx), closing bitmap each time
      decodedDims = { width: 100, height: 100 };
      ctxMode = 'null';
      await expect(tryProcessClientEdge(l1aItem)).resolves.toBeNull();
      expect(closeCount).toBe(3);

      // L2 oversized bitmap escalates as L2 and closes bitmap
      offscreenAllocCount = 0;
      decodedDims = { width: 5000, height: 5000 };
      ctxMode = 'ok';
      const l2Item: ConversionQueueItem = {
        id: 'l2-big',
        file,
        name: 'in.png',
        size: file.size,
        sourceFormat: 'png',
        targetFormat: 'webp',
        status: 'ready',
        progress: 0,
        options: { grayscale: true } as ConversionQueueItem['options'],
      };
      await expect(tryProcessClientEdge(l2Item)).rejects.toMatchObject({
        name: 'ClientEdgeEscalationError',
        fallbackFrom: 'L2',
      });
      expect(closeCount).toBe(4);
      expect(offscreenAllocCount).toBe(0);

      // L2 drawImage throw closes bitmap cleanly
      decodedDims = { width: 100, height: 100 };
      ctxMode = 'throwDraw';
      await expect(tryProcessClientEdge(l2Item)).resolves.toBeNull();
      expect(closeCount).toBe(5);
    });
  });

  describe('3. Bundle download ticket store & POST ?prepare=1 / GET ?ticket= streaming route', () => {
    it('creates single-use 64-hex tickets with TTL, format validation, bounded map eviction, and Redis Lua consumption', async () => {
      const noRedisSpy = vi.spyOn(redisKeyStore, 'getRedisClient').mockReturnValue(undefined as never);
      try {
        const ticket = await createBundleTicket({
          files: [{ key: 'k1', name: 'a.txt' }],
          archiveName: 'out.zip',
          callerUserId: 'user_1',
          callerTier: 'free',
        });
        expect(ticket).toMatch(/^[0-9a-f]{64}$/);
        expect(await consumeBundleTicket('not-a-valid-ticket')).toBeNull();

        const first = await consumeBundleTicket(ticket);
        expect(first).toMatchObject({
          files: [{ key: 'k1', name: 'a.txt' }],
          archiveName: 'out.zip',
          callerUserId: 'user_1',
          callerTier: 'free',
        });
        expect(await consumeBundleTicket(ticket)).toBeNull();

        // Expired ticket is rejected on consume
        const expiredTicket = await createBundleTicket({
          files: [{ key: 'k2', name: 'b.txt' }],
          archiveName: 'old.zip',
          callerUserId: 'user_1',
          callerTier: 'free',
          createdAt: Date.now() - (BUNDLE_TICKET_TTL_SECONDS + 5) * 1000,
        });
        expect(await consumeBundleTicket(expiredTicket)).toBeNull();

        // Bounded eviction at MAX_LOCAL_BUNDLE_TICKETS
        const minted: string[] = [];
        for (let i = 0; i < MAX_LOCAL_BUNDLE_TICKETS + 5; i++) {
          minted.push(
            await createBundleTicket({
              files: [{ key: `k-${i}`, name: `f-${i}.txt` }],
              archiveName: 'bound.zip',
              callerUserId: 'user_bound',
              callerTier: 'free',
            })
          );
        }
        expect(await consumeBundleTicket(minted[0])).toBeNull();
        expect(await consumeBundleTicket(minted[minted.length - 1])).not.toBeNull();
      } finally {
        noRedisSpy.mockRestore();
      }

      // Redis path uses SET EX and atomic GET+DEL Lua EVAL
      const redisValues = new Map<string, string>();
      const setCalls: unknown[][] = [];
      const evalCalls: unknown[][] = [];
      vi.spyOn(redisKeyStore, 'getRedisClient').mockReturnValue({
        async set(key: string, val: string, mode: string, ttl: number) {
          setCalls.push([key, mode, ttl]);
          redisValues.set(key, val);
          return 'OK';
        },
        async eval(script: string, numKeys: number, key: string) {
          evalCalls.push([script, numKeys, key]);
          const val = redisValues.get(key) ?? null;
          if (val) redisValues.delete(key);
          return val;
        },
      } as never);

      const redisTicket = await createBundleTicket({
        files: [{ key: 'rk1', name: 'r.txt' }],
        archiveName: 'redis.zip',
        callerUserId: 'user_redis',
        callerTier: 'paid',
      });
      expect(setCalls[0][1]).toBe('EX');
      expect(setCalls[0][2]).toBe(BUNDLE_TICKET_TTL_SECONDS);
      const consumedRedis = await consumeBundleTicket(redisTicket);
      expect(consumedRedis?.callerUserId).toBe('user_redis');
      expect(evalCalls[0][0]).toContain("redis.call('GET'");
      expect(evalCalls[0][0]).toContain("redis.call('DEL'");
      expect(await consumeBundleTicket(redisTicket)).toBeNull();
    });

    it('supports POST ?prepare=1 and single-use owner-bound GET ?ticket=... ZIP streaming for signed-in and anonymous callers', async () => {
      const owner = userStore.sanitizeUser(
        await userStore.createUser({
          email: `bundle_ticket_${Date.now()}@test.io`,
          name: 'Ticket Owner',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const stranger = userStore.sanitizeUser(
        await userStore.createUser({
          email: `bundle_stranger_${Date.now()}@test.io`,
          name: 'Ticket Stranger',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const ownerKey = (await redisKeyStore.generateApiKey(owner.id, 'owner-bundle-key', { scopes: ['storage:download'] })).secretKey;
      const strangerKey = (await redisKeyStore.generateApiKey(stranger.id, 'stranger-bundle-key', { scopes: ['storage:download'] })).secretKey;
      const badScopeKey = (await redisKeyStore.generateApiKey(owner.id, 'no-download-scope', { scopes: ['convert:write'] })).secretKey;

      const k1 = `conversions/${owner.id}/one_${crypto.randomBytes(4).toString('hex')}.txt`;
      const k2 = `conversions/${owner.id}/two_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(k1, k2);
      await retentionMod.saveRetainedResult(storageProvider, k1, Buffer.from('alpha-content'), 'text/plain', 'one.txt');
      await retentionMod.saveRetainedResult(storageProvider, k2, Buffer.from('beta-content'), 'text/plain', 'two.txt');

      const releaseSpy = vi.fn();
      const slotSpy = vi.spyOn(concurrencyLimitMod, 'acquireSyncSlot').mockResolvedValue({
        granted: true,
        release: releaseSpy,
      });

      const prepRes = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            archiveName: 'prepared.zip',
            files: [
              { key: k1, name: 'one.txt' },
              { key: k2, name: 'two.txt' },
            ],
          }),
        })
      );
      expect(prepRes.status).toBe(200);
      expect(prepRes.headers.get('cache-control')).toBe('private, no-store');
      expect(releaseSpy).toHaveBeenCalledTimes(1);
      const prepBody = (await prepRes.json()) as { success: boolean; downloadUrl: string };
      expect(prepBody.success).toBe(true);
      expect(prepBody.downloadUrl).toMatch(/^\/api\/storage\/bundle\?ticket=[0-9a-f]{64}$/);

      // Bad scope credential fails with 403
      const badScopeGet = await bundleGet(
        new NextRequest(`http://localhost${prepBody.downloadUrl}`, {
          headers: { Authorization: `Bearer ${badScopeKey}` },
        })
      );
      expect(badScopeGet.status).toBe(403);

      // Re-prepare for stranger mismatch check -> returns 404
      const prepRes2 = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ archiveName: 'prepared.zip', files: [{ key: k1, name: 'one.txt' }] }),
        })
      );
      const prepBody2 = (await prepRes2.json()) as { downloadUrl: string };
      const strangerGet = await bundleGet(
        new NextRequest(`http://localhost${prepBody2.downloadUrl}`, {
          headers: { Authorization: `Bearer ${strangerKey}` },
        })
      );
      expect(strangerGet.status).toBe(404);

      // Unauthenticated GET with owner's ticket also returns 404
      const prepRes3 = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ archiveName: 'prepared.zip', files: [{ key: k1, name: 'one.txt' }] }),
        })
      );
      const prepBody3 = (await prepRes3.json()) as { downloadUrl: string };
      const unauthGet = await bundleGet(new NextRequest(`http://localhost${prepBody3.downloadUrl}`));
      expect(unauthGet.status).toBe(404);

      // Valid owner session cookie streams real ZIP and consumes ticket
      const prepRes4 = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            archiveName: 'prepared.zip',
            files: [
              { key: k1, name: 'one.txt' },
              { key: k2, name: 'two.txt' },
            ],
          }),
        })
      );
      const prepBody4 = (await prepRes4.json()) as { downloadUrl: string };
      slotSpy.mockClear();
      releaseSpy.mockClear();

      const validGet = await bundleGet(
        new NextRequest(`http://localhost${prepBody4.downloadUrl}`, {
          headers: { cookie: `easyconvert_session=${createSessionToken(owner)}` },
        })
      );
      expect(validGet.status).toBe(200);
      expect(validGet.headers.get('content-type')).toBe('application/zip');
      const zipBuf = Buffer.from(await validGet.arrayBuffer());
      const adm = new AdmZip(zipBuf);
      expect(adm.readAsText('one.txt')).toBe('alpha-content');
      expect(adm.readAsText('two.txt')).toBe('beta-content');
      expect(slotSpy).toHaveBeenCalledTimes(1);
      expect(releaseSpy).toHaveBeenCalledTimes(1);

      // Reusing same ticket returns 404
      const replayGet = await bundleGet(
        new NextRequest(`http://localhost${prepBody4.downloadUrl}`, {
          headers: { cookie: `easyconvert_session=${createSessionToken(owner)}` },
        })
      );
      expect(replayGet.status).toBe(404);

      // Anonymous caller ticket: GET succeeds even when burst tokens were exhausted, and fails from different IP
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      vi.stubEnv('ANONYMOUS_BURST_CAPACITY', '1');
      vi.stubEnv('ANONYMOUS_BURST_REFILL_RATE', '0');
      const anonKey = `uploads/anon_prep_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(anonKey);
      await storageProvider.saveObject(anonKey, Buffer.from('anon-bundle'), 'text/plain', 'anon.txt');

      const anonPrep = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.55' },
          body: JSON.stringify({ files: [{ key: anonKey, name: 'anon.txt' }], archiveName: 'anon.zip' }),
        })
      );
      expect(anonPrep.status).toBe(200);
      const anonPrepBody = (await anonPrep.json()) as { downloadUrl: string };

      const wrongIpGet = await bundleGet(
        new NextRequest(`http://localhost${anonPrepBody.downloadUrl}`, {
          headers: { 'x-forwarded-for': '203.0.113.99' },
        })
      );
      expect(wrongIpGet.status).toBe(404);

      // Re-prepare with another IP whose single burst token is spent by POST ?prepare=1
      const anonPrep2 = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
          body: JSON.stringify({ files: [{ key: anonKey, name: 'anon.txt' }], archiveName: 'anon.zip' }),
        })
      );
      expect(anonPrep2.status).toBe(200);
      const anonPrepBody2 = (await anonPrep2.json()) as { downloadUrl: string };

      const sameIpGet = await bundleGet(
        new NextRequest(`http://localhost${anonPrepBody2.downloadUrl}`, {
          headers: { 'x-forwarded-for': '203.0.113.77' },
        })
      );
      expect(sameIpGet.status).toBe(200);
      const anonZip = new AdmZip(Buffer.from(await sameIpGet.arrayBuffer()));
      expect(anonZip.readAsText('anon.txt')).toBe('anon-bundle');
    });

    it('checks all remaining bundle keys on 404/410, triggers deleteResult for every expired key, and returns unavailableKeys', async () => {
      const owner = userStore.sanitizeUser(
        await userStore.createUser({
          email: `bundle_multi_exp_${Date.now()}@test.io`,
          name: 'Multi Expiry',
          tier: 'paid',
          emailVerified: true,
        })
      );
      const ownerKey = (await redisKeyStore.generateApiKey(owner.id, 'multi-exp-key', { scopes: ['storage:download'] })).secretKey;

      const exp1 = `conversions/${owner.id}/exp1_${crypto.randomBytes(4).toString('hex')}.txt`;
      const exp2 = `conversions/${owner.id}/exp2_${crypto.randomBytes(4).toString('hex')}.txt`;
      const live = `conversions/${owner.id}/live_${crypto.randomBytes(4).toString('hex')}.txt`;
      createdStorageKeys.push(exp1, exp2, live);

      await retentionMod.saveRetainedResult(storageProvider, exp1, Buffer.from('e1'), 'text/plain', 'e1.txt');
      await retentionMod.saveRetainedResult(storageProvider, exp2, Buffer.from('e2'), 'text/plain', 'e2.txt');
      await retentionMod.saveRetainedResult(storageProvider, live, Buffer.from('ok'), 'text/plain', 'ok.txt');

      await getRetentionLedger().update(exp1, (rec) => (rec ? { ...rec, deleteAt: Date.now() - 60_000 } : undefined));
      await getRetentionLedger().update(exp2, (rec) => (rec ? { ...rec, deleteAt: Date.now() - 60_000 } : undefined));

      const deleteSpy = vi.spyOn(retentionMod, 'deleteResult');
      const res = await bundlePost(
        new NextRequest('http://localhost/api/storage/bundle?prepare=1', {
          method: 'POST',
          headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            files: [
              { key: exp1, name: 'e1.txt' },
              { key: live, name: 'ok.txt' },
              { key: exp2, name: 'e2.txt' },
            ],
          }),
        })
      );
      expect(res.status).toBe(410);
      const json = (await res.json()) as { success: boolean; unavailableKeys: string[] };
      expect(json.success).toBe(false);
      expect(json.unavailableKeys.sort()).toEqual([exp1, exp2].sort());
      expect(deleteSpy).toHaveBeenCalledWith(storageProvider, exp1);
      expect(deleteSpy).toHaveBeenCalledWith(storageProvider, exp2);
    });
  });

  describe('4. Streaming ZIP download helpers & useClientQueue bundle streaming', () => {
    it('materializeZipStreamUrl streams through OPFS createWritable when available, sanitizes filename, and registers session cleanup', async () => {
      const opfs = createFakeOpfsRoot();
      vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.rootDir } });
      const createdObjects: unknown[] = [];
      const revokedUrls: string[] = [];
      vi.stubGlobal('URL', {
        createObjectURL: (obj: unknown) => {
          createdObjects.push(obj);
          return `blob:opfs/${createdObjects.length}`;
        },
        revokeObjectURL: (url: string) => {
          revokedUrls.push(url);
        },
      });

      const stream = streamZipReadable([{ name: 'hello.txt', data: new TextEncoder().encode('streamed via opfs') }]);
      const url = await materializeZipStreamUrl(stream, '../../unsafe/my-archive.zip');
      expect(url).toBe('blob:opfs/1');
      expect(opfs.dirs.size).toBe(1);
      const [sessionId, sessionFiles] = [...opfs.dirs.entries()][0];
      expect([...sessionFiles.keys()]).toEqual(['my-archive.zip']);
      const file = createdObjects[0] as File;
      const parsed = await JSZip.loadAsync(await file.arrayBuffer());
      expect(await parsed.file('hello.txt')?.async('string')).toBe('streamed via opfs');

      await releaseEdgeResultResources(url);
      expect(opfs.removedSessions).toEqual([sessionId]);
      expect(revokedUrls).toEqual([]);
    });

    it('cleans up OPFS session and does not fall back to memory when OPFS write fails or exceeds MAX_OPFS_ZIP_BYTES', async () => {
      const opfs = createFakeOpfsRoot();
      vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.rootDir } });
      const createObjectUrlSpy = vi.fn(() => 'blob:unexpected');
      vi.stubGlobal('URL', { createObjectURL: createObjectUrlSpy, revokeObjectURL: vi.fn() });

      let cancelled = false;
      const hugeStream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Fake oversized chunk via byteLength property getter? Use a 2-chunk sequence where second pushes past 2 GiB using a wrapper
          controller.enqueue({ byteLength: MAX_OPFS_ZIP_BYTES + 1 } as unknown as Uint8Array);
        },
        cancel() {
          cancelled = true;
        },
      });

      await expect(materializeZipStreamUrl(hugeStream, 'too-big.zip')).rejects.toThrow(/OPFS download limit/);
      expect(cancelled).toBe(true);
      expect(opfs.dirs.size).toBe(0);
      expect(opfs.removedSessions).toHaveLength(1);
      expect(createObjectUrlSpy).not.toHaveBeenCalled();

      // Mid-write OPFS disk error aborts writable, cleans session, and never falls back to memory
      const failingRoot = {
        async getDirectoryHandle() {
          return {
            async getDirectoryHandle() {
              return {
                async getDirectoryHandle() {
                  return {
                    async getFileHandle() {
                      return {
                        async createWritable() {
                          return {
                            async write() {
                              throw new Error('QuotaExceededError');
                            },
                            async close() {},
                            async abort() {},
                          };
                        },
                        async getFile() {
                          throw new Error('should not read file');
                        },
                      };
                    },
                  };
                },
                async removeEntry() {
                  return undefined;
                },
              };
            },
          };
        },
      };
      vi.stubGlobal('navigator', { storage: { getDirectory: async () => failingRoot } });
      let writeCancelled = false;
      const failWriteStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel() {
          writeCancelled = true;
        },
      });
      await expect(materializeZipStreamUrl(failWriteStream, 'quota-fail.zip')).rejects.toThrow('QuotaExceededError');
      expect(writeCancelled).toBe(true);
      expect(createObjectUrlSpy).not.toHaveBeenCalled();
    });

    it('falls back to bounded in-memory Blob when OPFS createWritable is unavailable and rejects > MAX_IN_MEMORY_ZIP_BYTES', async () => {
      vi.stubGlobal('navigator', {});
      const createdObjects: Blob[] = [];
      const revokedUrls: string[] = [];
      const clickedLinks: Array<{ href: string; download: string }> = [];
      vi.stubGlobal('URL', {
        createObjectURL: (obj: Blob) => {
          createdObjects.push(obj);
          return `blob:mem/${createdObjects.length}`;
        },
        revokeObjectURL: (url: string) => {
          revokedUrls.push(url);
        },
      });
      vi.stubGlobal('document', {
        body: { appendChild: vi.fn() },
        createElement: () => ({
          href: '',
          download: '',
          click() {
            clickedLinks.push({ href: this.href, download: this.download });
          },
          remove: vi.fn(),
        }),
      });

      vi.useFakeTimers({ toFake: ['setTimeout'] });
      const okStream = streamZipReadable([{ name: 'note.txt', data: new TextEncoder().encode('mem ok') }]);
      const zipUrl = await downloadZipStream(okStream, 'fallback.zip');
      expect(zipUrl).toBe('blob:mem/1');
      expect(clickedLinks).toEqual([{ href: 'blob:mem/1', download: 'fallback.zip' }]);
      const loaded = await JSZip.loadAsync(await createdObjects[0].arrayBuffer());
      expect(await loaded.file('note.txt')?.async('string')).toBe('mem ok');
      vi.advanceTimersByTime(60_000);
      expect(revokedUrls).toEqual(['blob:mem/1']);
      vi.useRealTimers();

      let memCancelled = false;
      const oversizedFallback = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue({ byteLength: MAX_IN_MEMORY_ZIP_BYTES + 1 } as unknown as Uint8Array);
        },
        cancel() {
          memCancelled = true;
        },
      });
      await expect(materializeZipStreamUrl(oversizedFallback, 'too-big-mem.zip')).rejects.toThrow(/in-memory download limit/);
      expect(memCancelled).toBe(true);
    });

    it('useClientQueue downloads server bundles via POST ?prepare=1 ticket anchor with zero res.blob() calls and marks unavailableKeys on 410', async () => {
      const clicked: Array<{ href: string; download: string }> = [];
      vi.stubGlobal('document', {
        body: { appendChild: vi.fn() },
        createElement: () => ({
          href: '',
          download: '',
          click() {
            clicked.push({ href: this.href, download: this.download });
          },
          remove: vi.fn(),
        }),
      });
      const createUrlSpy = vi.fn(() => 'blob:unexpected');
      vi.stubGlobal('URL', { createObjectURL: createUrlSpy, revokeObjectURL: vi.fn() });

      const prepareRequests: Array<{ url: string; body: unknown }> = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          prepareRequests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          const res = new Response(JSON.stringify({ success: true, downloadUrl: '/api/storage/bundle?ticket=abc123' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
          vi.spyOn(res, 'blob').mockImplementation(() => {
            throw new Error('res.blob() must not be called for server bundles');
          });
          return res;
        })
      );

      const items: ConversionQueueItem[] = [
        {
          id: 's1',
          file: new File([], 'a.png'),
          name: 'a.png',
          size: 10,
          sourceFormat: 'png',
          targetFormat: 'jpg',
          status: 'completed',
          progress: 100,
          options: {},
          resultUrl: '/api/storage/file/conversions%2Fu1%2Fa.jpg',
        },
        {
          id: 's2',
          file: new File([], 'b.png'),
          name: 'b.png',
          size: 10,
          sourceFormat: 'png',
          targetFormat: 'jpg',
          status: 'completed',
          progress: 100,
          options: {},
          resultUrl: '/api/storage/file/conversions%2Fu1%2Fb.jpg',
        },
      ];

      let queueState = items;
      const setZipError = vi.fn();
      const ctx = {
        bundlePrefix: 'batch',
        queueRef: { current: items },
        mountedRef: { current: true },
        blobUrlsRef: { current: new Set<string>() },
        timersRef: { current: new Set<ReturnType<typeof setTimeout>>() },
        setZipError,
        revokeBlobUrl: vi.fn(),
        updateQueue: (fn: (prev: ConversionQueueItem[]) => ConversionQueueItem[]) => {
          queueState = fn(queueState);
        },
      } as unknown as QueueMutationContext;

      await createDownloadAllZipHandler(ctx)();
      expect(prepareRequests).toHaveLength(1);
      expect(prepareRequests[0].url).toBe('/api/storage/bundle?prepare=1');
      expect(clicked).toHaveLength(1);
      expect(clicked[0].href).toBe('/api/storage/bundle?ticket=abc123');
      expect(clicked[0].download).toMatch(/^batch_\d+\.zip$/);
      expect(createUrlSpy).not.toHaveBeenCalled();
      expect(setZipError).toHaveBeenLastCalledWith(false);

      // Now simulate 410 with unavailableKeys naming only s2
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: 'expired',
              unavailableKeys: ['conversions/u1/b.jpg'],
            }),
            { status: 410 }
          )
        )
      );
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await createDownloadAllZipHandler(ctx)();
      expect(setZipError).toHaveBeenLastCalledWith(true);
      expect(queueState.map((i) => [i.id, i.status])).toEqual([
        ['s1', 'completed'],
        ['s2', 'error'],
      ]);
      expect(queueState[1].resultUrl).toBeUndefined();
    });

    it('useClientQueue streams local blob entries sequentially via res.body into OPFS without calling res.blob()', async () => {
      const opfs = createFakeOpfsRoot();
      vi.stubGlobal('navigator', { storage: { getDirectory: async () => opfs.rootDir } });
      const clicked: Array<{ href: string; download: string }> = [];
      vi.stubGlobal('document', {
        body: { appendChild: vi.fn() },
        createElement: () => ({
          href: '',
          download: '',
          click() {
            clicked.push({ href: this.href, download: this.download });
          },
          remove: vi.fn(),
        }),
      });
      const createdFiles: File[] = [];
      vi.stubGlobal('URL', {
        createObjectURL: (file: File) => {
          createdFiles.push(file);
          return `blob:zip/${createdFiles.length}`;
        },
        revokeObjectURL: vi.fn(),
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const text = url === 'blob:1' ? 'first payload' : 'second payload';
          const res = new Response(text);
          vi.spyOn(res, 'blob').mockImplementation(() => {
            throw new Error('res.blob() must not be called when res.body is available');
          });
          return res;
        })
      );

      const items: ConversionQueueItem[] = [
        {
          id: 'l1',
          file: new File([], 'first.png'),
          name: 'first.png',
          size: 10,
          sourceFormat: 'png',
          targetFormat: 'webp',
          status: 'completed',
          progress: 100,
          options: {},
          resultUrl: 'blob:1',
        },
        {
          id: 'l2',
          file: new File([], 'second.png'),
          name: 'second.png',
          size: 10,
          sourceFormat: 'png',
          targetFormat: 'webp',
          status: 'completed',
          progress: 100,
          options: {},
          resultUrl: 'blob:2',
        },
      ];

      const revokeSpy = vi.fn((u?: string) => {
        if (u) void releaseEdgeResultResources(u);
      });
      const blobUrls = new Set<string>();
      const timers = new Set<ReturnType<typeof setTimeout>>();
      const ctx = {
        bundlePrefix: 'edge',
        queueRef: { current: items },
        mountedRef: { current: true },
        blobUrlsRef: { current: blobUrls },
        timersRef: { current: timers },
        setZipError: vi.fn(),
        revokeBlobUrl: revokeSpy,
        updateQueue: vi.fn(),
      } as unknown as QueueMutationContext;

      vi.useFakeTimers({ toFake: ['setTimeout'] });
      await createDownloadAllZipHandler(ctx)();
      expect(clicked).toHaveLength(1);
      expect(clicked[0].href).toBe('blob:zip/1');
      expect(blobUrls.has('blob:zip/1')).toBe(true);

      const loaded = await JSZip.loadAsync(await createdFiles[0].arrayBuffer());
      expect(await loaded.file('first.webp')?.async('string')).toBe('first payload');
      expect(await loaded.file('second.webp')?.async('string')).toBe('second payload');

      // Timer cleans up both blob URL and OPFS session
      vi.advanceTimersByTime(60_000);
      expect(revokeSpy).toHaveBeenCalledWith('blob:zip/1');
      await vi.waitFor(() => expect(opfs.removedSessions).toHaveLength(1));
      vi.useRealTimers();

      // Unmounted mid-download revokes zipUrl and destroys OPFS session immediately;
      // mid-stream error in entry 0 cancels unread stream on entry 1.
      let secondEntryCancelled = false;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          if (url === 'blob:1') {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error('entry 1 stream broken'));
                },
              })
            );
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                secondEntryCancelled = true;
              },
            })
          );
        })
      );
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const setZipError = vi.fn();
      const ctxErr = {
        ...ctx,
        setZipError,
      } as unknown as QueueMutationContext;
      await createDownloadAllZipHandler(ctxErr)();
      expect(setZipError).toHaveBeenCalledWith(true);
      expect(secondEntryCancelled).toBe(true);
    });

    it('triggerAnchorDownload attaches, clicks, removes, and returns URL', () => {
      const calls: string[] = [];
      const el = {
        href: '',
        download: '',
        click() {
          calls.push(`click:${this.href}:${this.download}`);
        },
        remove() {
          calls.push('remove');
        },
      };
      vi.stubGlobal('document', {
        body: {
          appendChild(node: unknown) {
            expect(node).toBe(el);
            calls.push('append');
          },
        },
        createElement(tag: string) {
          expect(tag).toBe('a');
          return el;
        },
      });
      expect(triggerAnchorDownload('/api/storage/bundle?ticket=t1', 'pack.zip')).toBe('/api/storage/bundle?ticket=t1');
      expect(calls).toEqual(['append', 'click:/api/storage/bundle?ticket=t1:pack.zip', 'remove']);
    });
  });
});
