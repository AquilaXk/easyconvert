import fs from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as multipartPost } from '../src/app/api/storage/multipart/route';
import { PUT as directPartPut } from '../src/app/api/v1/uploads/direct/part/route';
import { s3Storage } from '../src/lib/storage/s3-storage';

const BASE_URL = 'http://localhost:3000';
const MIB = 1024 * 1024;
const PART_BYTES = 5 * MIB;
const OK = 200;
const PAYLOAD_TOO_LARGE = 413;

const cleanups: Array<() => void> = [];

beforeEach(() => {
  vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

let visitorCount = 0;

function newVisitor(): Record<string, string> {
  visitorCount += 1;
  return { 'x-forwarded-for': `203.0.113.${100 + visitorCount}` };
}

async function openSession(headers: Record<string, string>, totalSize: number): Promise<{ uploadId: string; key: string }> {
  const res = await multipartPost(
    new NextRequest(`${BASE_URL}/api/storage/multipart?action=initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ filename: 'a.csv', mimeType: 'text/csv', totalSize, partSize: PART_BYTES }),
    })
  );
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(OK);
  cleanups.push(() => {
    s3Storage.abortMultipartUpload(body.uploadId);
    s3Storage.deleteObject(body.key);
  });
  return body;
}

function partRequest(uploadId: string, partNumber: number, bytes: Buffer, headers: Record<string, string>): NextRequest {
  return new NextRequest(
    `${BASE_URL}/api/storage/multipart?action=chunk&uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: new Uint8Array(bytes) }
  );
}

function storedBytes(uploadId: string): number {
  return (s3Storage.getUploadedParts(uploadId) ?? []).reduce((sum, part) => sum + part.size, 0);
}

/** The files in the session's directory: the stored parts, and any temporary file a refused part left. */
function sessionFiles(uploadId: string): string[] {
  const session = s3Storage.getUploadSession(uploadId);
  return session ? fs.readdirSync(session.diskDir).sort() : [];
}

function countOf(statuses: number[], status: number): number {
  return statuses.filter((value) => value === status).length;
}

describe('parts of one upload sent at once are held together to the size it declared', () => {
  it('stores one of six parts that each would fill a session declared at 5 MiB and refuses the others', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);

    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'x'), visitor)))
    );

    const statuses = results.map((res) => res.status);
    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    expect(countOf(statuses, PAYLOAD_TOO_LARGE), String(statuses)).toBe(5);
    expect(storedBytes(uploadId)).toBe(PART_BYTES);
    expect(sessionFiles(uploadId)).toHaveLength(1);
  });

  it('refuses the parts that declare more than is left, before any byte of them is written', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);
    const declaring = { ...visitor, 'Content-Length': String(PART_BYTES) };

    const results = await Promise.all(
      [1, 2, 3].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'x'), declaring)))
    );

    const statuses = results.map((res) => res.status);
    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    const refusal = await results[statuses.indexOf(PAYLOAD_TOO_LARGE)].json();
    expect(refusal.detail).toBe(`This part would bring the upload to ${2 * PART_BYTES} bytes, past the ${PART_BYTES} bytes it declared.`);
    expect(storedBytes(uploadId)).toBe(PART_BYTES);
  });

  it('takes a repeat of a part that races the first attempt, since only one of them can be the part', async () => {
    const visitor = newVisitor();
    const { uploadId } = await openSession(visitor, PART_BYTES);

    const results = await Promise.all([1, 1].map((n) => multipartPost(partRequest(uploadId, n, Buffer.alloc(PART_BYTES, 'y'), visitor))));

    expect(results.map((res) => res.status)).toEqual([OK, OK]);
    expect(storedBytes(uploadId)).toBe(PART_BYTES);
  });

  it('holds the parts of the signed part route to the declared size the same way', async () => {
    const init = s3Storage.initiateMultipartUpload('b.csv', 'text/csv', PART_BYTES, 'user_parts', PART_BYTES);
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(init.uploadId);
    });
    const send = (n: number) =>
      directPartPut(
        new NextRequest(s3Storage.generatePresignedUploadUrl(init.key, n, init.uploadId).url, {
          method: 'PUT',
          body: new Uint8Array(Buffer.alloc(PART_BYTES, 'z')),
        })
      );

    const statuses = (await Promise.all([1, 2, 3, 4].map(send))).map((res) => res.status);

    expect(countOf(statuses, OK), String(statuses)).toBe(1);
    expect(countOf(statuses, PAYLOAD_TOO_LARGE), String(statuses)).toBe(3);
    expect(storedBytes(init.uploadId)).toBe(PART_BYTES);
  });
});

describe('the store sums the stored parts again when it commits one', () => {
  it('removes a part that would pass the declared size although it was admitted against an older sum', async () => {
    const init = s3Storage.initiateMultipartUpload('c.csv', 'text/csv', PART_BYTES, 'user_parts', PART_BYTES);
    cleanups.push(() => {
      s3Storage.abortMultipartUpload(init.uploadId);
    });
    await s3Storage.uploadPartStream(init.uploadId, 1, Readable.from([Buffer.alloc(PART_BYTES, 'a')]), PART_BYTES, PART_BYTES, 0);

    const late = s3Storage.uploadPartStream(init.uploadId, 2, Readable.from([Buffer.alloc(MIB, 'b')]), PART_BYTES, PART_BYTES, 0);

    await expect(late).rejects.toMatchObject({ statusCode: PAYLOAD_TOO_LARGE });
    expect(storedBytes(init.uploadId)).toBe(PART_BYTES);
    expect(sessionFiles(init.uploadId)).toEqual(['part-1.bin']);
  });
});
