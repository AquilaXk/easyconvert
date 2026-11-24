import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as toolsJobsPost } from '../src/app/api/tools/jobs/route';
import { POST as mergeToolPost } from '../src/app/api/tools/merge/route';
import { POST as inspectArchivePost } from '../src/app/api/v1/archives/inspect/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { InMemoryIdempotencyStore, setIdempotencyStore } from '../src/lib/api/idempotency';
import {
  MAX_MULTIPART_BODY_BYTES,
  MAX_MULTIPART_FIELD_BYTES,
  MAX_MULTIPART_FILES,
  readMultipartForm,
  releaseMultipartForm,
} from '../src/lib/api/multipart-body';
import { SMALL_REQUEST_BODY_MAX_BYTES } from '../src/lib/api/request-body-limit';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import { DEFAULT_MAX_INPUT_PIXELS, InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { assertMediaImageFileWithinLimit } from '../src/lib/conversions/media';
import { resetInputProbeCache } from '../src/lib/conversions/media-ffprobe';
import { PICTURE_HEADER_READ_BYTES, readPictureFileHead, sharpInput } from '../src/lib/conversions/picture-file';
import { SINGLE_REQUEST_BODY_MAX_BYTES } from '../src/lib/plan-limits';
import { setDiskProbe } from '../src/lib/storage/retention-service';
import { JOB_STAGING_MAX_AGE_MS } from '../src/lib/storage/temp-file';
import { RequestAbortedError } from '../src/lib/types';
import { convertWithNativeFfmpeg } from '../src/worker/engines';
import { SANDBOX_STALE_AFTER_MS, sweepWorkerSandboxDirs } from '../src/worker/sandbox-sweep';
import { bombBmp, bombPng, bombTiff } from './helpers/image-bombs';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const MULTIPART_SCRATCH_PREFIX = 'easyconvert-multipart-';

function buildMultiMbBmpV5(width: number, height: number, totalSizeBytes: number): Buffer {
  const fileHeaderBytes = 14;
  const v5HeaderBytes = 124;
  const pixelOffset = fileHeaderBytes + v5HeaderBytes;
  const buf = Buffer.alloc(Math.max(totalSizeBytes, pixelOffset + 4));
  buf.write('BM', 0, 'ascii');
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(pixelOffset, 10);
  buf.writeUInt32LE(v5HeaderBytes, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22);
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(32, 28);
  buf.writeUInt32LE(0, 30);
  return buf;
}

function padBufferToBytes(prefix: Buffer, targetBytes: number): Buffer {
  if (prefix.length >= targetBytes) return prefix;
  return Buffer.concat([prefix, Buffer.alloc(targetBytes - prefix.length)]);
}

function makeRawMultipartRequest(
  url: string,
  boundary: string,
  chunks: readonly (Buffer | Uint8Array | string)[],
  headers: Record<string, string> = {},
  signal?: AbortSignal
): NextRequest {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : new Uint8Array(chunk));
      }
      controller.close();
    },
  });
  return new NextRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    duplex: 'half',
    ...(signal ? { signal } : {}),
  });
}

function makeOversizedStreamRequest(
  url: string,
  targetTotalBytes: number,
  headers: Record<string, string> = {}
): { req: NextRequest; chunksPulled: () => number; wasCancelled: () => boolean } {
  const boundary = '----ec-overflow-boundary';
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="huge.csv"\r\nContent-Type: text/csv\r\n\r\n`,
    'utf-8'
  );
  const trailer = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
  const fillerChunk = Buffer.alloc(MIB, 0x61);
  let sent = 0;
  let pulled = 0;
  let cancelled = false;
  let sentPreamble = false;

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      if (!sentPreamble) {
        sentPreamble = true;
        sent += preamble.byteLength;
        controller.enqueue(new Uint8Array(preamble));
        return;
      }
      if (sent < targetTotalBytes) {
        const remaining = targetTotalBytes - sent;
        const sliceLen = Math.min(fillerChunk.byteLength, remaining);
        sent += sliceLen;
        controller.enqueue(new Uint8Array(fillerChunk.subarray(0, sliceLen)));
        return;
      }
      controller.enqueue(new Uint8Array(trailer));
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  const req = new NextRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...headers,
    },
    body,
    duplex: 'half',
  });
  return {
    req,
    chunksPulled: () => pulled,
    wasCancelled: () => cancelled,
  };
}

function multipartDirsIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(MULTIPART_SCRATCH_PREFIX));
}

async function createPaidCaller(): Promise<{ userId: string; apiKey: string; cookie: string }> {
  const user = userStore.sanitizeUser(
    await userStore.createUser({
      email: `stream_mp_${Date.now()}_${crypto.randomBytes(6).toString('hex')}@easyconvert.local`,
      name: 'Streaming Multipart Tester',
      tier: 'paid',
      emailVerified: true,
    })
  );
  await redisKeyStore.creditPackage(user.id, {
    transactionId: `txn_${user.id}`,
    credits: 1000,
    paid: '0',
    at: Date.now(),
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Streaming Key', {
    scopes: ['convert:write', 'convert:read'],
  });
  return {
    userId: user.id,
    apiKey: key.secretKey,
    cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(user)}`,
  };
}

describe('Bounded FFmpeg image header reads (PICTURE_HEADER_READ_BYTES & pictureFileHead)', () => {
  runWithoutFileConfinement();

  let tmpDir = '';
  let spyDir = '';
  let spyLog = '';

  function writeSpyBinary(name: string, scriptBody: string): string {
    const file = path.join(spyDir, name);
    fs.writeFileSync(file, scriptBody, { mode: 0o755 });
    return file;
  }

  function invocationsOf(name: string): string[] {
    if (!fs.existsSync(spyLog)) return [];
    return fs
      .readFileSync(spyLog, 'utf-8')
      .split('\n')
      .filter((line) => line.trim() === name);
  }

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-img-head-test-'));
    spyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-img-head-spy-'));
    spyLog = path.join(spyDir, 'calls.log');
    writeSpyBinary(
      'ffmpeg',
      `#!/bin/sh\ncase "$*" in\n  *-encoders*|*-hwaccels*|*-version*) exit 0 ;;\nesac\necho "ffmpeg" >> "${spyLog}"\nfor last in "$@"; do :; done\ncase "$last" in\n  /*) printf '\\000\\000\\000\\030ftypmp42\\000\\000\\000\\000mp42isom' > "$last" ;;\nesac\nexit 0\n`
    );
    writeSpyBinary(
      'ffprobe',
      `#!/bin/sh\necho "ffprobe" >> "${spyLog}"\nprintf '%s\\n' '{"streams":[{"index":0,"codec_type":"video","codec_name":"bmp","width":64,"height":64}],"format":{"start_time":"0.0","duration":"1.0"},"chapters":[]}'\nexit 0\n`
    );
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(spyDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(spyLog, { force: true });
    vi.stubEnv('FFMPEG_PATH', path.join(spyDir, 'ffmpeg'));
    vi.stubEnv('FFPROBE_PATH', path.join(spyDir, 'ffprobe'));
    resetInputProbeCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetInputProbeCache();
  });

  it('reads at most PICTURE_HEADER_READ_BYTES (>= 256) from disk without calling fs.readFileSync', async () => {
    expect(PICTURE_HEADER_READ_BYTES).toBe(4096);
    expect(PICTURE_HEADER_READ_BYTES).toBeGreaterThanOrEqual(256);

    const validBmpPath = path.join(tmpDir, 'valid-v5-4mb.bmp');
    fs.writeFileSync(validBmpPath, buildMultiMbBmpV5(64, 64, 4 * MIB));

    const validPngBytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const validPngPath = path.join(tmpDir, 'valid-2mb.png');
    fs.writeFileSync(validPngPath, padBufferToBytes(validPngBytes, 2 * MIB));

    const validTiffBytes = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .tiff()
      .toBuffer();
    const validTiffPath = path.join(tmpDir, 'valid-2mb.tiff');
    fs.writeFileSync(validTiffPath, padBufferToBytes(validTiffBytes, 2 * MIB));

    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    const bmpHead = await readPictureFileHead(validBmpPath);
    const pngHead = await readPictureFileHead(validPngPath);
    const tiffHead = await readPictureFileHead(validTiffPath);

    expect(bmpHead.length).toBe(PICTURE_HEADER_READ_BYTES);
    expect(pngHead.length).toBe(PICTURE_HEADER_READ_BYTES);
    expect(tiffHead.length).toBe(PICTURE_HEADER_READ_BYTES);
    expect(sharpInput(bmpHead)).toBe(validBmpPath);
    expect(sharpInput(pngHead)).toBe(validPngPath);
    expect(sharpInput(tiffHead)).toBe(validTiffPath);

    await assertMediaImageFileWithinLimit(validBmpPath);
    await assertMediaImageFileWithinLimit(validPngPath);
    await assertMediaImageFileWithinLimit(validTiffPath);
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it('rejects oversized BMP V5, PNG, and TIFF headers via assertMediaImageFileWithinLimit without fs.readFileSync', async () => {
    const bombBmpV5Path = path.join(tmpDir, 'bomb-v5-3mb.bmp');
    fs.writeFileSync(bombBmpV5Path, buildMultiMbBmpV5(15_000, 15_000, 3 * MIB));

    const bombPngPath = path.join(tmpDir, 'bomb-2mb.png');
    fs.writeFileSync(bombPngPath, padBufferToBytes(bombPng(15_000, 15_000), 2 * MIB));

    const bombTiffPath = path.join(tmpDir, 'bomb-2mb.tiff');
    fs.writeFileSync(bombTiffPath, padBufferToBytes(bombTiff(15_000, 15_000), 2 * MIB));

    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    for (const filePath of [bombBmpV5Path, bombPngPath, bombTiffPath]) {
      let caught: unknown;
      try {
        await assertMediaImageFileWithinLimit(filePath);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InputPixelLimitError);
      expect(caught).toMatchObject({
        status: 413,
        limit: DEFAULT_MAX_INPUT_PIXELS,
        width: 15_000,
        height: 15_000,
      });
    }
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  it('checks BMP V5 and multi-MiB GIF in convertWithNativeFfmpeg without fs.readFileSync(inputPath) and never spawns ffmpeg on pixel bombs', async () => {
    const bombV5Path = path.join(tmpDir, 'ffmpeg-v5-bomb.bmp');
    fs.writeFileSync(bombV5Path, buildMultiMbBmpV5(15_000, 15_000, 3 * MIB));

    const validV5Path = path.join(tmpDir, 'ffmpeg-v5-ok.bmp');
    fs.writeFileSync(validV5Path, buildMultiMbBmpV5(64, 64, 3 * MIB));

    const validGifBytes = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .gif()
      .toBuffer();
    const validGifPath = path.join(tmpDir, 'ffmpeg-ok-2mb.gif');
    fs.writeFileSync(validGifPath, padBufferToBytes(validGifBytes, 2 * MIB));

    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    let bombError: unknown;
    try {
      await convertWithNativeFfmpeg({ inputPath: bombV5Path }, 'bmp', 'mp4', { throwOnUnavailable: true }, 'bomb.bmp');
    } catch (err) {
      bombError = err;
    }
    expect(bombError).toBeInstanceOf(InputPixelLimitError);
    expect(bombError).toMatchObject({ status: 413, width: 15_000, height: 15_000 });
    expect(invocationsOf('ffmpeg')).toEqual([]);
    expect(readFileSyncSpy.mock.calls.some(([p]) => p === bombV5Path)).toBe(false);

    // Valid BMP V5 passes the image-header pixel gate (openMediaInput subsequently refuses .bmp as a media demuxer)
    let bmpDemuxerErr: unknown;
    try {
      await convertWithNativeFfmpeg({ inputPath: validV5Path }, 'bmp', 'mp4', { disableHwaccel: true, throwOnUnavailable: true }, 'ok.bmp');
    } catch (err) {
      bmpDemuxerErr = err;
    }
    expect(bmpDemuxerErr).toBeInstanceOf(Error);
    expect((bmpDemuxerErr as Error).name).toBe('RefusedMediaInputError');
    expect(readFileSyncSpy.mock.calls.some(([p]) => p === validV5Path)).toBe(false);

    // Valid multi-MiB GIF passes image-header check and reaches ffmpeg without calling fs.readFileSync on inputPath
    const res = await convertWithNativeFfmpeg(
      { inputPath: validGifPath },
      'gif',
      'mp4',
      { disableHwaccel: true, throwOnUnavailable: true },
      'ok.gif'
    );
    expect(res?.engineUsed).toBe('native-ffmpeg');
    expect(invocationsOf('ffmpeg')).toEqual(['ffmpeg']);
    expect(readFileSyncSpy.mock.calls.some(([p]) => p === validGifPath)).toBe(false);
  });

  it('rejects BMP INFO header bomb via assertMediaImageFileWithinLimit without fs.readFileSync', async () => {
    const infoBombPath = path.join(tmpDir, 'bomb-info.bmp');
    fs.writeFileSync(infoBombPath, padBufferToBytes(bombBmp(16_000, 16_000), 512 * 1024));
    const readFileSyncSpy = vi.spyOn(fs, 'readFileSync');

    let caught: unknown;
    try {
      await assertMediaImageFileWithinLimit(infoBombPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InputPixelLimitError);
    expect(caught).toMatchObject({ status: 413, width: 16_000, height: 16_000 });
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });
});

describe('Streaming multipart disk spill, route cleanup, and adversarial bounds', () => {
  let isolatedTmp = '';

  beforeEach(() => {
    isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-mp-isolated-'));
    vi.stubEnv('TMPDIR', isolatedTmp);
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    setIdempotencyStore(new InMemoryIdempotencyStore());
    setDiskProbe(async () => 0);
  });

  afterEach(() => {
    setDiskProbe(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  });

  it('spills files to 0o700/0o600 disk paths, preserves UTF-8 Korean, path-bearing names, arrival order, and cleans up on release', async () => {
    const formDataSpy = vi.spyOn(Request.prototype, 'formData');
    const boundary = '----ec-order-boundary';
    const rawBody = [
      `--${boundary}\r\nContent-Disposition: form-data; name="step"\r\n\r\nfirst\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="한글_보고서.txt"\r\nContent-Type: text/plain\r\n\r\n첫번째 내용\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="step"\r\n\r\nsecond\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="../sub/evil.txt"\r\nContent-Type: text/plain\r\n\r\nsecond bytes\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="empty.bin"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`,
      `--${boundary}--\r\n`,
    ];
    const req = makeRawMultipartRequest('http://localhost/test', boundary, rawBody);

    const parsed = await readMultipartForm(req);
    expect(parsed.malformed).toBeUndefined();
    expect(formDataSpy).not.toHaveBeenCalled();

    const dirs = multipartDirsIn(isolatedTmp);
    expect(dirs).toHaveLength(1);
    const scratchDir = path.join(isolatedTmp, dirs[0]);
    expect(fs.statSync(scratchDir).mode & 0o777).toBe(0o700);
    const partStat = fs.statSync(path.join(scratchDir, 'part-0.bin'));
    expect(partStat.mode & 0o777).toBe(0o600);

    const entries = Array.from(parsed.form!.entries());
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual(['step', 'first']);
    expect(entries[1][0]).toBe('files');
    expect(entries[1][1]).toBeInstanceOf(File);
    expect((entries[1][1] as File).name).toBe('한글_보고서.txt');
    expect(await (entries[1][1] as File).text()).toBe('첫번째 내용');
    expect(entries[2]).toEqual(['step', 'second']);
    expect((entries[3][1] as File).name).toBe('../sub/evil.txt');
    expect(await (entries[3][1] as File).text()).toBe('second bytes');
    expect((entries[4][1] as File).name).toBe('empty.bin');
    expect((entries[4][1] as File).size).toBe(0);

    await releaseMultipartForm(req);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
  });

  it('cleans scratch dirs deterministically after POST /api/v1/convert (200, 202 async, 400) and POST /api/convert/batch', async () => {
    const caller = await createPaidCaller();
    const formDataSpy = vi.spyOn(Request.prototype, 'formData');

    const makeCsvReq = (extraHeaders: Record<string, string> = {}, targetFormat = 'json') => {
      const form = new FormData();
      form.append('file', new File(['a,b\n1,2\n'], 'data.csv', { type: 'text/csv' }));
      form.append('targetFormat', targetFormat);
      return new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.apiKey}`, ...extraHeaders },
        body: form,
      });
    };

    const res200 = await v1ConvertPost(makeCsvReq());
    expect(res200.status).toBe(200);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const res202 = await v1ConvertPost(makeCsvReq({ Prefer: 'respond-async' }));
    expect(res202.status).toBe(202);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const res400 = await v1ConvertPost(makeCsvReq({}, 'not_a_real_format'));
    expect(res400.status).toBe(400);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const batchForm = new FormData();
    batchForm.append('files', new File(['a,b\n1,2\n'], 'one.csv', { type: 'text/csv' }));
    batchForm.append('files', new File(['c,d\n3,4\n'], 'two.csv', { type: 'text/csv' }));
    batchForm.append('targetFormats', JSON.stringify({ default: 'json' }));
    const batchRes = await batchPost(
      new NextRequest(`${BASE_URL}/api/convert/batch`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${caller.apiKey}` },
        body: batchForm,
      })
    );
    expect(batchRes.status).toBe(200);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
    expect(formDataSpy).not.toHaveBeenCalled();
  });

  it('rejects truncated multipart payloads without closing boundary as 400 and cleans scratch dirs', async () => {
    const caller = await createPaidCaller();
    const boundary = '----ec-trunc-boundary';
    const truncatedChunks = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cut.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n`,
    ];

    const directReq = makeRawMultipartRequest(`${BASE_URL}/api/v1/convert`, boundary, truncatedChunks);
    const directRead = await readMultipartForm(directReq);
    expect(directRead.malformed).toBeInstanceOf(Error);
    expect(directRead.malformed?.message).toMatch(/Unexpected end/i);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const routeReq = makeRawMultipartRequest(`${BASE_URL}/api/v1/convert`, boundary, truncatedChunks, {
      Authorization: `Bearer ${caller.apiKey}`,
    });
    const res = await v1ConvertPost(routeReq);
    expect(res.status).toBe(400);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
  });

  it('returns 413 and cleans scratch dirs across all 8 multipart routes when streaming body exceeds SINGLE_REQUEST_BODY_MAX_BYTES without Content-Length', async () => {
    const caller = await createPaidCaller();
    const authHeaders = { Authorization: `Bearer ${caller.apiKey}` };
    const oversizeBytes = SINGLE_REQUEST_BODY_MAX_BYTES + 1;
    expect(MAX_MULTIPART_BODY_BYTES).toBe(SINGLE_REQUEST_BODY_MAX_BYTES);

    const routes: Array<{ name: string; path: string; handler: (req: NextRequest) => Promise<Response> }> = [
      { name: '/api/convert', path: '/api/convert', handler: convertPost },
      { name: '/api/convert/batch', path: '/api/convert/batch', handler: batchPost },
      { name: '/api/v1/convert', path: '/api/v1/convert', handler: v1ConvertPost },
      { name: '/api/tools/jobs', path: '/api/tools/jobs', handler: toolsJobsPost },
      { name: '/api/tools/merge', path: '/api/tools/merge', handler: mergeToolPost },
      { name: '/api/v1/archives/inspect', path: '/api/v1/archives/inspect', handler: inspectArchivePost },
      { name: '/api/queue/jobs', path: '/api/queue/jobs', handler: queueJobsPost },
      { name: '/api/v1/jobs', path: '/api/v1/jobs', handler: v1JobsPost },
    ];

    for (const route of routes) {
      const { req, chunksPulled, wasCancelled } = makeOversizedStreamRequest(
        `${BASE_URL}${route.path}`,
        oversizeBytes + MIB,
        authHeaders
      );
      const res = await route.handler(req);
      expect(res.status, route.name).toBe(413);
      expect(wasCancelled(), route.name).toBe(true);
      expect(chunksPulled(), route.name).toBeLessThanOrEqual(68);
      expect(multipartDirsIn(isolatedTmp), route.name).toEqual([]);
    }
  });

  it('returns 413 for text fields > 2 MiB and boundedJsonFieldProblem 413 for 1.2 MiB JSON text fields', async () => {
    const caller = await createPaidCaller();
    const authHeaders = { Authorization: `Bearer ${caller.apiKey}` };
    expect(MAX_MULTIPART_FIELD_BYTES).toBe(2 * SMALL_REQUEST_BODY_MAX_BYTES);

    // > 2 MiB text field -> Busboy valueTruncated -> PayloadLimitError -> 413
    const hugeFieldReq = makeRawMultipartRequest(
      `${BASE_URL}/api/v1/convert`,
      '----ec-bigfield',
      [
        `------ec-bigfield\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n\r\n`,
        `------ec-bigfield\r\nContent-Disposition: form-data; name="options"\r\n\r\n`,
        'x'.repeat(MAX_MULTIPART_FIELD_BYTES + 1024),
        `\r\n------ec-bigfield--\r\n`,
      ],
      authHeaders
    );
    const hugeFieldRes = await v1ConvertPost(hugeFieldReq);
    expect(hugeFieldRes.status).toBe(413);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    // 1.2 MiB JSON options field -> passes Busboy (<= 2 MiB) -> boundedJsonFieldProblem 413
    const padLen = Math.floor(1.2 * MIB);
    const midJson = JSON.stringify({ background: `#${'a'.repeat(padLen)}` });
    const midJsonReq = makeRawMultipartRequest(
      `${BASE_URL}/api/v1/convert`,
      '----ec-midjson',
      [
        `------ec-midjson\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n\r\n`,
        `------ec-midjson\r\nContent-Disposition: form-data; name="targetFormat"\r\n\r\njson\r\n`,
        `------ec-midjson\r\nContent-Disposition: form-data; name="options"\r\n\r\n${midJson}\r\n`,
        `------ec-midjson--\r\n`,
      ],
      authHeaders
    );
    const midJsonRes = await v1ConvertPost(midJsonReq);
    expect(midJsonRes.status).toBe(413);
    const midBody = await midJsonRes.json();
    expect(midBody.detail).toContain(String(SMALL_REQUEST_BODY_MAX_BYTES));
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
  });

  it('rejects > 128 file parts with 400 malformed while letting 101-file batch requests reach too_many_files 400', async () => {
    const caller = await createPaidCaller();
    const authHeaders = { Authorization: `Bearer ${caller.apiKey}` };
    const boundary = '----ec-manyfiles';

    const buildFileParts = (count: number): string[] => {
      const chunks: string[] = [];
      for (let i = 0; i < count; i++) {
        chunks.push(
          `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="f_${i}.csv"\r\nContent-Type: text/csv\r\n\r\na,b\n1,2\n\r\n`
        );
      }
      chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="targetFormats"\r\n\r\n{"default":"json"}\r\n`);
      chunks.push(`--${boundary}--\r\n`);
      return chunks;
    };

    const overBusboyReq = makeRawMultipartRequest(
      `${BASE_URL}/api/convert/batch`,
      boundary,
      buildFileParts(MAX_MULTIPART_FILES + 1),
      authHeaders
    );
    const overBusboyRes = await batchPost(overBusboyReq);
    expect(overBusboyRes.status).toBe(400);
    const overBusboyBody = await overBusboyRes.json();
    expect(overBusboyBody.detail).toContain('Invalid or malformed multipart/form-data body');
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const batch101Req = makeRawMultipartRequest(
      `${BASE_URL}/api/convert/batch`,
      boundary,
      buildFileParts(101),
      authHeaders
    );
    const batch101Res = await batchPost(batch101Req);
    expect(batch101Res.status).toBe(400);
    const batch101Body = await batch101Res.json();
    expect(batch101Body.code).toBe('too_many_files');
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
  });

  it('throws RequestAbortedError and returns 499 with clean scratch dirs when stream is aborted mid-upload', async () => {
    const caller = await createPaidCaller();
    const boundary = '----ec-abort-boundary';
    const encoder = new TextEncoder();

    const makeSlowAbortedReq = (controller: AbortController, headers: Record<string, string>) => {
      let step = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(streamCtrl) {
          step++;
          if (step === 1) {
            streamCtrl.enqueue(
              encoder.encode(
                `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="slow.csv"\r\nContent-Type: text/csv\r\n\r\nhello`
              )
            );
            setTimeout(() => controller.abort(new Error('client disconnect')), 15);
            return;
          }
          // Keep stream open until abort cancels it
        },
      });
      return new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          ...headers,
        },
        body,
        duplex: 'half',
        signal: controller.signal,
      });
    };

    const ctrl1 = new AbortController();
    const req1 = makeSlowAbortedReq(ctrl1, {});
    await expect(readMultipartForm(req1)).rejects.toBeInstanceOf(RequestAbortedError);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);

    const ctrl2 = new AbortController();
    const req2 = makeSlowAbortedReq(ctrl2, { Authorization: `Bearer ${caller.apiKey}` });
    const res = await v1ConvertPost(req2);
    expect(res.status).toBe(499);
    expect(multipartDirsIn(isolatedTmp)).toEqual([]);
  });

  it('sweeps stale easyconvert-multipart-* dirs via sweepWorkerSandboxDirs while preserving fresh ones', () => {
    const staleDir = fs.mkdtempSync(path.join(isolatedTmp, MULTIPART_SCRATCH_PREFIX));
    const freshDir = fs.mkdtempSync(path.join(isolatedTmp, MULTIPART_SCRATCH_PREFIX));
    fs.writeFileSync(path.join(staleDir, 'part-0.bin'), 'stale');
    fs.writeFileSync(path.join(freshDir, 'part-0.bin'), 'fresh');

    const staleAgeMs = Math.max(SANDBOX_STALE_AFTER_MS, JOB_STAGING_MAX_AGE_MS) + 60_000;
    const oldTime = new Date(Date.now() - staleAgeMs);
    fs.utimesSync(staleDir, oldTime, oldTime);

    const removed = sweepWorkerSandboxDirs({ directory: isolatedTmp });
    expect(removed).toEqual([path.basename(staleDir)]);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
  });
});
