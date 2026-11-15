import { describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { streamZip, streamZipReadable } from '../src/lib/archive/streaming-zip';
import { POST as bundlePost } from '../src/app/api/storage/bundle/route';
import { NextRequest } from 'next/server';

describe('streaming-zip generator (client-zip MIT port)', () => {
  it('creates a valid STORE zip archive from memory buffers with valid CRC32', async () => {
    const file1 = Buffer.from('Hello world from file 1');
    const file2 = Buffer.from('Another test file with content 2');

    const entries = [
      { name: 'hello.txt', data: file1, size: file1.length },
      { name: 'sub/nested.txt', data: file2, size: file2.length },
    ];

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamZip(entries)) {
      chunks.push(chunk);
    }

    const zipBuffer = Buffer.concat(chunks);
    expect(zipBuffer.length).toBeGreaterThan(0);

    const adm = new AdmZip(zipBuffer);
    const admEntries = adm.getEntries();
    expect(admEntries.map((e) => e.entryName).sort()).toEqual(['hello.txt', 'sub/nested.txt']);
    expect(adm.readAsText('hello.txt')).toBe('Hello world from file 1');
    expect(adm.readAsText('sub/nested.txt')).toBe('Another test file with content 2');
  });

  it('streams zip chunks via ReadableStream in streamZipReadable', async () => {
    const content = Buffer.from('Streaming test data');
    const entries = [{ name: 'stream.txt', data: content, size: content.length }];

    const stream = streamZipReadable(entries);
    const res = new Response(stream);
    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);

    const adm = new AdmZip(zipBuffer);
    expect(adm.getEntries().map((e) => e.entryName)).toEqual(['stream.txt']);
    expect(adm.readAsText('stream.txt')).toBe('Streaming test data');
  });
});

describe('POST /api/storage/bundle', () => {
  it('refuses invalid or empty JSON body', async () => {
    const req = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await bundlePost(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('refuses unknown or unauthorized storage key with 404', async () => {
    const req = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ key: 'conversions/unknown-user-id/12345_test.pdf', name: 'test.pdf' }],
      }),
    });
    const res = await bundlePost(req);
    expect(res.status).toBe(404);
  });
});
