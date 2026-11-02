import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { fetch as undiciFetch } from 'undici';
import { vi } from 'vitest';

/** A server on this machine that sends `body` gzipped and declares the compressed length as its `Content-Length`. */
export async function gzipServer(body: string): Promise<{ url: string; compressedBytes: number; close: () => Promise<void> }> {
  const compressed = zlib.gzipSync(body);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-encoding': 'gzip', 'content-length': String(compressed.length) });
    res.end(compressed);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/scores.csv`,
    compressedBytes: compressed.length,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A `gzipServer` that every fetch of a link in the suite reaches through the real `undici` client, which asks for gzip and
 * decodes it as it does in production, so the reader sees the decoded bytes under a declared length that is the compressed
 * one. The suite mocks `undici`'s fetch; this points that mock at the real one.
 */
export async function gzipRemote(body: string): Promise<{ compressedBytes: number; close: () => Promise<void> }> {
  const server = await gzipServer(body);
  const { fetch: realFetch } = await vi.importActual<typeof import('undici')>('undici');
  vi.mocked(undiciFetch).mockImplementation(async (_target, init) => {
    const { dispatcher: _dispatcher, ...request } = (init ?? {}) as Record<string, unknown>;
    return realFetch(server.url, request) as never;
  });
  return server;
}
