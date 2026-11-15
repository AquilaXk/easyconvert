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
              storageKey: `uploads/${uploadId}/big.bin`,
              partSize: 5,
              partUrls: [{ partNumber: 1, url: 'https://storage.test/part1' }],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        )
        .mockResolvedValueOnce(
          new Response(null, { status: 200, headers: { ETag: '"etag-1"' } })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ storageKey: `uploads/${uploadId}/big.bin` }), {
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
        expect.objectContaining({ href: 'https://api.easyconvert.test/api/v1/archive/inspect' }),
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
        expect.objectContaining({ href: 'https://api.easyconvert.test/api/v1/archive/inspect' }),
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
