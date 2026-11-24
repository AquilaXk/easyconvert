import { describe, it, expect, vi } from 'vitest';
import { EasyConvertClient } from '../sdk/typescript/src/client';
import crypto from 'node:crypto';

describe('SDK Ergonomic Helpers', () => {
  const API_KEY = 'ec_live_testapikey1234567890';
  const BASE_URL = 'https://api.easyconvert.test';

  describe('verifyWebhookSignature', () => {
    const SECRET = 'whsec_test_secret_abc123';
    const PAYLOAD = JSON.stringify({ event: 'job.completed', jobId: 'job_123' });
    const NOW = Math.floor(Date.now() / 1000);

    function computeSignature(payload: string, secret: string, timestamp: number): string {
      return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    }

    it('verifies valid signature successfully', async () => {
      const sig = computeSignature(PAYLOAD, SECRET, NOW);
      const valid = await EasyConvertClient.verifyWebhookSignature(PAYLOAD, sig, NOW, SECRET);
      expect(valid).toBe(true);
    });

    it('handles sha256= prefix', async () => {
      const sig = `sha256=${computeSignature(PAYLOAD, SECRET, NOW)}`;
      const valid = await EasyConvertClient.verifyWebhookSignature(PAYLOAD, sig, NOW, SECRET);
      expect(valid).toBe(true);
    });

    it('rejects expired timestamp (replay attack prevention)', async () => {
      const oldTime = NOW - 600; // 10 minutes ago
      const sig = computeSignature(PAYLOAD, SECRET, oldTime);
      const valid = await EasyConvertClient.verifyWebhookSignature(PAYLOAD, sig, oldTime, SECRET, 300);
      expect(valid).toBe(false);
    });

    it('rejects wrong secret', async () => {
      const sig = computeSignature(PAYLOAD, 'wrong_secret', NOW);
      const valid = await EasyConvertClient.verifyWebhookSignature(PAYLOAD, sig, NOW, SECRET);
      expect(valid).toBe(false);
    });

    it('rejects tampered payload', async () => {
      const sig = computeSignature(PAYLOAD, SECRET, NOW);
      const tampered = JSON.stringify({ event: 'job.completed', jobId: 'job_tampered' });
      const valid = await EasyConvertClient.verifyWebhookSignature(tampered, sig, NOW, SECRET);
      expect(valid).toBe(false);
    });
  });

  describe('createGraphJob', () => {
    it('sends graph payload as JSON to /api/v1/jobs', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ jobId: 'job_graph_123', statusUrl: '/api/v1/jobs/job_graph_123' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const graph = {
        nodes: {
          n1: { op: 'convert', targetFormat: 'pdf' },
        },
      };

      const result = await client.createGraphJob({ graph, webhookUrl: 'https://example.com/webhook', webhookSecret: 'secret' });
      expect(result.jobId).toBe('job_graph_123');
      expect(result.statusUrl).toBe('/api/v1/jobs/job_graph_123');

      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://api.easyconvert.test/api/v1/jobs' }),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
          }),
        })
      );
    });
  });

  describe('uploadTus', () => {
    it('performs chunked upload with tus protocol', async () => {
      const uploadId = 'tus_session_456';
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(null, {
            status: 201,
            headers: {
              Location: `/api/v1/uploads/${uploadId}`,
              'Tus-Resumable': '1.0.0',
            },
          })
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 204,
            headers: {
              'Tus-Resumable': '1.0.0',
              'Upload-Offset': '10',
              'Storage-Key': `uploads/${uploadId}/test.txt`,
            },
          })
        );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob(['0123456789'], { type: 'text/plain' });

      const result = await client.uploadTus(file, { filename: 'test.txt', chunkSize: 10 });
      expect(result.uploadId).toBe(uploadId);
      expect(result.storageKey).toBe(`uploads/${uploadId}/test.txt`);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('uploadMultipart', () => {
    it('initiates, uploads parts, and completes direct multipart', async () => {
      const uploadId = 'mp_session_789';
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              uploadId,
              key: `uploads/${uploadId}/big.bin`,
              partSize: 5,
              parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/part1', expiresAt: 9999999999 }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 200, headers: { ETag: '"etag-1"' } })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ key: `uploads/${uploadId}/big.bin` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob(['12345'], { type: 'application/octet-stream' });

      const result = await client.uploadMultipart(file, { filename: 'big.bin' });
      expect(result.uploadId).toBe(uploadId);
      expect(result.storageKey).toBe(`uploads/${uploadId}/big.bin`);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('requests presigned URLs on demand when totalParts exceeds initial parts returned by /api/v1/uploads/direct', async () => {
      const uploadId = 'mp_session_paginated';
      const key = `uploads/${uploadId}/large.bin`;
      const uploadedChunks: string[] = [];
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/v1/uploads/direct')) {
          return new Response(
            JSON.stringify({
              uploadId,
              key,
              partSize: 4,
              totalParts: 3,
              parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/part1', expiresAt: 9999999999 }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/uploads?action=presign')) {
          const payload = JSON.parse(String(init?.body)) as { uploadId: string; key: string; partNumber: number };
          expect(payload.uploadId).toBe(uploadId);
          expect(payload.key).toBe(key);
          return new Response(
            JSON.stringify({ success: true, url: `https://storage.test/part${payload.partNumber}` }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.startsWith('https://storage.test/part')) {
          const partNum = url.slice('https://storage.test/part'.length);
          uploadedChunks.push(await (init?.body as Blob).text());
          return new Response(null, { status: 200, headers: { ETag: `"etag-${partNum}"` } });
        }
        if (url.endsWith('/api/v1/uploads/direct/complete')) {
          const completed = JSON.parse(String(init?.body)) as { parts: Array<{ partNumber: number; etag: string }> };
          expect(completed.parts).toEqual([
            { partNumber: 1, etag: '"etag-1"' },
            { partNumber: 2, etag: '"etag-2"' },
            { partNumber: 3, etag: '"etag-3"' },
          ]);
          return new Response(JSON.stringify({ key }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob(['AAAABBBBCC'], { type: 'application/octet-stream' });

      const result = await client.uploadMultipart(file, { filename: 'large.bin', partSize: 4 });
      expect(result).toEqual({ uploadId, storageKey: key });
      expect(uploadedChunks).toEqual(['AAAA', 'BBBB', 'CC']);
    });

    it('fetches parts 101..105 via action=presign when direct init caps initial parts at 100', async () => {
      const uploadId = 'mp_cap_105';
      const key = `uploads/${uploadId}/large105.bin`;
      const presignedParts: number[] = [];
      const futureMs = Date.now() + 900_000;
      const initialParts = Array.from({ length: 100 }, (_, idx) => ({
        partNumber: idx + 1,
        uploadUrl: `https://storage.test/part/${idx + 1}`,
        expiresAt: futureMs,
      }));
      let completedCount = 0;

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/v1/uploads/direct')) {
          return new Response(
            JSON.stringify({ uploadId, key, partSize: 1, totalParts: 105, parts: initialParts }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/uploads?action=presign')) {
          const payload = JSON.parse(String(init?.body)) as { partNumber: number };
          presignedParts.push(payload.partNumber);
          return new Response(
            JSON.stringify({ success: true, url: `https://storage.test/presigned/${payload.partNumber}` }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.startsWith('https://storage.test/')) {
          const partNum = url.split('/').pop();
          return new Response(null, { status: 200, headers: { ETag: `"etag-${partNum}"` } });
        }
        if (url.endsWith('/api/v1/uploads/direct/complete')) {
          const completed = JSON.parse(String(init?.body)) as { parts: Array<{ partNumber: number; etag: string }> };
          completedCount = completed.parts.length;
          return new Response(JSON.stringify({ key }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob([new Uint8Array(105).fill(65)], { type: 'application/octet-stream' });

      const result = await client.uploadMultipart(file, { filename: 'large105.bin', partSize: 1 });
      expect(result).toEqual({ uploadId, storageKey: key });
      expect(presignedParts).toEqual([101, 102, 103, 104, 105]);
      expect(completedCount).toBe(105);
    });

    it('refreshes initial presigned URLs via action=presign when expiresAt is expired or within leeway', async () => {
      const uploadId = 'mp_expired_initial';
      const key = `uploads/${uploadId}/refresh.bin`;
      const putUrls: string[] = [];
      const presignedParts: number[] = [];

      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/v1/uploads/direct')) {
          return new Response(
            JSON.stringify({
              uploadId,
              key,
              partSize: 4,
              totalParts: 2,
              parts: [
                { partNumber: 1, uploadUrl: 'https://storage.test/stale/1', expiresAt: Date.now() - 5_000 },
                { partNumber: 2, uploadUrl: 'https://storage.test/stale/2', expiresAt: Math.floor((Date.now() + 2_000) / 1000) },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/uploads?action=presign')) {
          const payload = JSON.parse(String(init?.body)) as { partNumber: number };
          presignedParts.push(payload.partNumber);
          return new Response(
            JSON.stringify({ success: true, url: `https://storage.test/fresh/${payload.partNumber}` }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.startsWith('https://storage.test/')) {
          putUrls.push(url);
          const partNum = url.split('/').pop();
          return new Response(null, { status: 200, headers: { ETag: `"etag-${partNum}"` } });
        }
        if (url.endsWith('/api/v1/uploads/direct/complete')) {
          return new Response(JSON.stringify({ key }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob(['AAAABBBB'], { type: 'application/octet-stream' });

      await client.uploadMultipart(file, { filename: 'refresh.bin', partSize: 4 });
      expect(presignedParts).toEqual([1, 2]);
      expect(putUrls).toEqual(['https://storage.test/fresh/1', 'https://storage.test/fresh/2']);
    });

    it('fails closed on untrusted totalParts above 10_000 or non-positive partSize', async () => {
      for (const badInit of [
        { uploadId: 'mp_huge', key: 'k', partSize: 4, totalParts: 100_000_000, parts: [] },
        { uploadId: 'mp_zero', key: 'k', partSize: 4, totalParts: 0, parts: [] },
        { uploadId: 'mp_bad_size', key: 'k', partSize: 0, totalParts: 1, parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/1' }] },
        { uploadId: 'mp_decimal_size', key: 'k', partSize: 0.5, totalParts: 1, parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/1' }] },
        { uploadId: 'mp_negative_size', key: 'k', partSize: -4, totalParts: 1, parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/1' }] },
      ]) {
        const mockFetch = vi.fn(async () =>
          new Response(JSON.stringify(badInit), { status: 200, headers: { 'Content-Type': 'application/json' } })
        ) as unknown as typeof fetch;
        const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
        await expect(client.uploadMultipart(new Blob(['ABCD']), { filename: 'bad.bin' })).rejects.toThrow(
          /Invalid multipart/
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }

      for (const nonFiniteSize of [Number.NaN, Number.POSITIVE_INFINITY]) {
        const mockFetch = vi.fn(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            uploadId: 'mp_nonfinite',
            key: 'k',
            partSize: nonFiniteSize,
            totalParts: 1,
            parts: [{ partNumber: 1, uploadUrl: 'https://storage.test/1' }],
          }),
        })) as unknown as typeof fetch;
        const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
        await expect(client.uploadMultipart(new Blob(['ABCD']), { filename: 'bad.bin' })).rejects.toThrow(
          /Invalid multipart partSize/
        );
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }

      for (const badOptionSize of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const mockFetch = vi.fn() as unknown as typeof fetch;
        const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
        await expect(
          client.uploadMultipart(new Blob(['ABCD']), { filename: 'bad-opt.bin', partSize: badOptionSize })
        ).rejects.toThrow(/Invalid multipart partSize/);
        expect(mockFetch).toHaveBeenCalledTimes(0);
      }
    });

    it('rejects non-array parts, invalid/duplicate/out-of-range partNumbers, and gapped un-declared parts', async () => {
      const badPayloads: Array<{ init: unknown; message: RegExp }> = [
        { init: { uploadId: 'mp_str_parts', key: 'k', partSize: 4, totalParts: 1, parts: 'bad' }, message: /Invalid multipart parts list/ },
        { init: { uploadId: 'mp_obj_parts', key: 'k', partSize: 4, totalParts: 1, parts: { 1: {} } }, message: /Invalid multipart parts list/ },
        { init: { uploadId: 'mp_null_parturls', key: 'k', partSize: 4, totalParts: 1, parts: null, partUrls: 'bad' }, message: /Invalid multipart parts list/ },
        { init: { uploadId: 'mp_null_entry', key: 'k', partSize: 4, totalParts: 1, parts: [null] }, message: /Invalid multipart part entry/ },
        { init: { uploadId: 'mp_arr_entry', key: 'k', partSize: 4, totalParts: 1, parts: [[1]] }, message: /Invalid multipart part entry/ },
        { init: { uploadId: 'mp_zero_part', key: 'k', partSize: 4, totalParts: 1, parts: [{ partNumber: 0, uploadUrl: 'https://storage.test/0' }] }, message: /Invalid multipart partNumber/ },
        { init: { uploadId: 'mp_neg_part', key: 'k', partSize: 4, totalParts: 1, parts: [{ partNumber: -1, uploadUrl: 'https://storage.test/-1' }] }, message: /Invalid multipart partNumber/ },
        { init: { uploadId: 'mp_float_part', key: 'k', partSize: 4, totalParts: 1, parts: [{ partNumber: 1.5, uploadUrl: 'https://storage.test/1' }] }, message: /Invalid multipart partNumber/ },
        { init: { uploadId: 'mp_bool_part', key: 'k', partSize: 4, totalParts: 1, parts: [{ partNumber: true, uploadUrl: 'https://storage.test/1' }] }, message: /Invalid multipart partNumber/ },
        {
          init: {
            uploadId: 'mp_dup_equal_len',
            key: 'k',
            partSize: 2,
            totalParts: 2,
            parts: [
              { partNumber: 1, uploadUrl: 'https://storage.test/1' },
              { partNumber: 1, uploadUrl: 'https://storage.test/1b' },
            ],
          },
          message: /Duplicate multipart partNumber/,
        },
        {
          init: {
            uploadId: 'mp_dup_no_total',
            key: 'k',
            partSize: 2,
            parts: [
              { partNumber: 1, uploadUrl: 'https://storage.test/1' },
              { partNumber: 1, uploadUrl: 'https://storage.test/1b' },
            ],
          },
          message: /Duplicate multipart partNumber/,
        },
        {
          init: {
            uploadId: 'mp_gap_equal_len',
            key: 'k',
            partSize: 2,
            totalParts: 2,
            parts: [
              { partNumber: 1, uploadUrl: 'https://storage.test/1' },
              { partNumber: 3, uploadUrl: 'https://storage.test/3' },
            ],
          },
          message: /exceeds totalParts/,
        },
        {
          init: {
            uploadId: 'mp_gap_no_total',
            key: 'k',
            partSize: 2,
            parts: [
              { partNumber: 1, uploadUrl: 'https://storage.test/1' },
              { partNumber: 3, uploadUrl: 'https://storage.test/3' },
            ],
          },
          message: /missing contiguous partNumber 2/,
        },
        {
          init: {
            uploadId: 'mp_offset_no_total',
            key: 'k',
            partSize: 2,
            parts: [{ partNumber: 2, uploadUrl: 'https://storage.test/2' }],
          },
          message: /missing contiguous partNumber 1/,
        },
      ];

      for (const { init, message } of badPayloads) {
        const mockFetch = vi.fn(async () =>
          new Response(JSON.stringify(init), { status: 200, headers: { 'Content-Type': 'application/json' } })
        ) as unknown as typeof fetch;
        const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
        await expect(client.uploadMultipart(new Blob(['ABCD']), { filename: 'bad.bin' })).rejects.toThrow(message);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      }

      const nanMockFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          uploadId: 'mp_nan_part',
          key: 'k',
          partSize: 4,
          totalParts: 1,
          parts: [{ partNumber: Number.NaN, uploadUrl: 'https://storage.test/1' }],
        }),
      })) as unknown as typeof fetch;
      const nanClient = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: nanMockFetch });
      await expect(nanClient.uploadMultipart(new Blob(['ABCD']), { filename: 'nan.bin' })).rejects.toThrow(
        /Invalid multipart partNumber/
      );
      expect(nanMockFetch).toHaveBeenCalledTimes(1);
    });

    it('presigns gaps via 1..totalParts when declaredTotalParts is present and orders unordered contiguous parts', async () => {
      const presigned: number[] = [];
      let completedParts: Array<{ partNumber: number; etag: string }> = [];
      const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/v1/uploads/direct')) {
          return new Response(
            JSON.stringify({
              uploadId: 'mp_sparse_3',
              key: 'uploads/mp_sparse_3/sparse.bin',
              partSize: 2,
              totalParts: 3,
              parts: [
                { partNumber: 3, uploadUrl: 'https://storage.test/sparse/3', expiresAt: 9999999999 },
                { partNumber: 1, uploadUrl: 'https://storage.test/sparse/1', expiresAt: 9999999999 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.endsWith('/api/v1/uploads?action=presign')) {
          const payload = JSON.parse(String(init?.body)) as { partNumber: number };
          presigned.push(payload.partNumber);
          return new Response(JSON.stringify({ url: `https://storage.test/sparse/${payload.partNumber}` }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.startsWith('https://storage.test/sparse/')) {
          const partNum = url.split('/').pop();
          return new Response(null, { status: 200, headers: { ETag: `"etag-${partNum}"` } });
        }
        if (url.endsWith('/api/v1/uploads/direct/complete')) {
          completedParts = (JSON.parse(String(init?.body)) as { parts: Array<{ partNumber: number; etag: string }> }).parts;
          return new Response(JSON.stringify({ key: 'uploads/mp_sparse_3/sparse.bin' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const res = await client.uploadMultipart(new Blob(['AABBCC']), { filename: 'sparse.bin', partSize: 2 });
      expect(res.uploadId).toBe('mp_sparse_3');
      expect(presigned).toEqual([2]);
      expect(completedParts).toEqual([
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ]);

      const uploadedOrder: number[] = [];
      const unorderedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/v1/uploads/direct')) {
          return new Response(
            JSON.stringify({
              uploadId: 'mp_unordered_contiguous',
              key: 'uploads/mp_unordered/file.bin',
              partSize: 2,
              parts: [
                { partNumber: 2, uploadUrl: 'https://storage.test/u/2', expiresAt: 9999999999 },
                { partNumber: 1, uploadUrl: 'https://storage.test/u/1', expiresAt: 9999999999 },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.startsWith('https://storage.test/u/')) {
          const partNum = Number(url.split('/').pop());
          uploadedOrder.push(partNum);
          return new Response(null, { status: 200, headers: { ETag: `"u-${partNum}"` } });
        }
        if (url.endsWith('/api/v1/uploads/direct/complete')) {
          const body = JSON.parse(String(init?.body)) as { parts: Array<{ partNumber: number; etag: string }> };
          expect(body.parts).toEqual([
            { partNumber: 1, etag: '"u-1"' },
            { partNumber: 2, etag: '"u-2"' },
          ]);
          return new Response(JSON.stringify({ key: 'uploads/mp_unordered/file.bin' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const unorderedClient = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: unorderedFetch });
      const unorderedRes = await unorderedClient.uploadMultipart(new Blob(['AABB']), { filename: 'unordered.bin', partSize: 2 });
      expect(unorderedRes.uploadId).toBe('mp_unordered_contiguous');
      expect(uploadedOrder).toEqual([1, 2]);
    });
  });

  describe('inspectArchive', () => {
    it('sends multipart request when file is given', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ format: 'zip', entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const file = new Blob(['PK...'], { type: 'application/zip' });

      const result = await client.inspectArchive({ file });
      expect(result.format).toBe('zip');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://api.easyconvert.test/api/v1/archives/inspect' }),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('sends JSON request when storageKey is given', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ format: 'zip', entries: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });
      const result = await client.inspectArchive({ storageKey: 'uploads/123/file.zip' });
      expect(result.format).toBe('zip');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.objectContaining({ href: 'https://api.easyconvert.test/api/v1/archives/inspect' }),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        })
      );
    });
  });

  describe('credentials management', () => {
    it('creates, lists, and deletes storage credentials', async () => {
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ credentialRef: 'cred_123', providerType: 's3' }), {
            status: 201,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ credentials: [{ credentialRef: 'cred_123' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 204 })
        );

      const client = new EasyConvertClient({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: mockFetch });

      const created = await client.createCredential({
        providerType: 's3',
        credentials: { type: 's3', bucket: 'my-bucket', accessKeyId: 'key', secretAccessKey: 'sec' },
      });
      expect(created.credentialRef).toBe('cred_123');

      const list = await client.listCredentials();
      expect(list.credentials).toHaveLength(1);

      await expect(client.deleteCredential('cred_123')).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
