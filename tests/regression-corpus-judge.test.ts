import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { judgeJobs } from '../bench/realworld/judge';
import type { CorpusFile } from '../bench/realworld/manifest';
import { locateCentralDirectory, parseCentralDirectory } from '../bench/realworld/zip-range';

/**
 * Fetching and judging a shard of the regression corpus against a local HTTP server that answers range requests out of a ZIP
 * archive written by JSZip. The expected digests are those of the payloads written here; the verdicts are what the real job
 * servers answer for a valid and a corrupt PNG (the same two files the pool test of the real-world corpus uses).
 */

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BROKEN_PNG = Buffer.concat([PNG_1X1.subarray(0, 40), Buffer.alloc(16)]);
const HEAP_MB = 1024;
const JOB_DEADLINE_MS = 120_000;
const TEST_TIMEOUT_MS = 240_000;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('fetching and judging a shard', () => {
  let server: http.Server;
  let base = '';
  let archive: Buffer;
  const requests: Array<{ range: string | undefined; bytes: number }> = [];
  let files: CorpusFile[];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'regression-judge-'));

  beforeAll(async () => {
    const zip = new JSZip();
    zip.file('good.png', PNG_1X1, { compression: 'STORE' });
    zip.file('broken.png', BROKEN_PNG, { compression: 'DEFLATE' });
    zip.file('padding.bin', Buffer.alloc(200_000, 7), { compression: 'STORE' });
    archive = await zip.generateAsync({ type: 'nodebuffer' });
    server = http.createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      if (match === null) {
        response.writeHead(416).end();
        requests.push({ range: undefined, bytes: 0 });
        return;
      }
      const body = archive.subarray(Number(match[1]), Number(match[2]) + 1);
      requests.push({ range: request.headers.range, bytes: body.length });
      response.writeHead(206, { 'content-length': body.length }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/a.zip`;
    const tail = archive.subarray(archive.length - 1024);
    const location = locateCentralDirectory(tail);
    const entries = parseCentralDirectory(archive.subarray(location.offset, location.offset + location.size), location.entries);
    const corpusFile = (name: string, payload: Buffer, digest = sha256(payload)): CorpusFile => {
      const entry = entries.find((candidate) => candidate.name === name)!;
      return {
        id: `rg-${name}`,
        source: 'test',
        format: 'png',
        size: payload.length,
        sha256: digest,
        origin: { kind: 'zip', archive: base, entry: name, offset: entry.localHeaderOffset, compressedSize: entry.compressedSize, method: entry.method },
      };
    };
    files = [corpusFile('good.png', PNG_1X1), corpusFile('broken.png', BROKEN_PNG), corpusFile('good.png', PNG_1X1, 'f'.repeat(64))];
    files[2] = { ...files[2], id: 'rg-wrong-digest.png' };
  });

  afterAll(() => {
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  });

  const options = (cacheDir: string): Parameters<typeof judgeJobs>[1] => ({
    cacheDir,
    workers: 1,
    deadlineMs: JOB_DEADLINE_MS,
    heapMb: HEAP_MB,
    env: { ...process.env, REALWORLD_PDFINFO: '', REALWORLD_IDENTIFY: '' },
    batchFiles: 1,
    deleteAfterJudged: true,
    collectFetchErrors: true,
  });

  it('judges each file by range reads alone, then deletes it', async () => {
    const cacheDir = path.join(work, 'cache-a');
    requests.length = 0;
    const result = await judgeJobs(
      [
        { file: files[0], target: 'bmp' },
        { file: files[1], target: 'bmp' },
      ],
      options(cacheDir)
    );
    expect(result.records.map((r) => `${r.file}:${r.target}:${r.verdict}`)).toEqual(['rg-good.png:bmp:ok', 'rg-broken.png:bmp:refused']);
    expect(result.unavailable).toEqual([]);
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : []).toEqual([]);
    // Two requests per file (the local header, then the data) and nothing else: the 200 kB padding entry is never read.
    expect(requests).toHaveLength(4);
    expect(requests.every((r) => r.range !== undefined && r.bytes <= PNG_1X1.length + 100)).toBe(true);
  }, TEST_TIMEOUT_MS);

  it('keeps the files of a run that asks to keep them', async () => {
    const cacheDir = path.join(work, 'cache-b');
    await judgeJobs([{ file: files[0], target: 'bmp' }], { ...options(cacheDir), deleteAfterJudged: false });
    expect(fs.readdirSync(cacheDir)).toEqual(['rg-good.png']);
  }, TEST_TIMEOUT_MS);

  it('reports a file whose bytes differ from the manifest as unavailable and still judges the others', async () => {
    const cacheDir = path.join(work, 'cache-c');
    const result = await judgeJobs(
      [
        { file: files[2], target: 'bmp' },
        { file: files[0], target: 'bmp' },
      ],
      options(cacheDir)
    );
    expect(result.records.map((r) => `${r.file}:${r.verdict}`)).toEqual(['rg-good.png:ok']);
    expect(result.unavailable).toHaveLength(1);
    expect(result.unavailable[0].file).toBe('rg-wrong-digest.png');
    expect(result.unavailable[0].reason).toMatch(/SHA-256/);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('fails the run on such a file when it is not asked to collect fetch errors', async () => {
    const cacheDir = path.join(work, 'cache-d');
    await expect(judgeJobs([{ file: files[2], target: 'bmp' }], { ...options(cacheDir), collectFetchErrors: false })).rejects.toMatchObject({ name: 'DigestMismatchError', message: expect.stringMatching(/SHA-256/) });
  }, TEST_TIMEOUT_MS);
});
