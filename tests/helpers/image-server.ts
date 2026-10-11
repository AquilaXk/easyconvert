import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';

/** One request the test server received. */
export interface ReceivedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export type RouteHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

export interface ImageServer {
  readonly port: number;
  /** Requests whose headers arrived. */
  readonly requests: ReceivedRequest[];
  /** TCP connections accepted, including ones that never sent a request. */
  connections(): number;
  route(path: string, handler: RouteHandler): void;
  /** Serves `body` with the given content type at `path`. */
  serve(path: string, body: Buffer | string, contentType?: string): void;
  close(): Promise<void>;
}

/** A listening HTTP server on 127.0.0.1 for the tests; nothing else on the machine or the network is contacted. */
export async function startImageServer(): Promise<ImageServer> {
  const routes = new Map<string, RouteHandler>();
  const requests: ReceivedRequest[] = [];
  let accepted = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((request, response) => {
    requests.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
    const path = new URL(request.url ?? '/', 'http://placeholder.invalid').pathname; // NOSONAR S5332: a parsing base for a request path, never connected to
    const handler = routes.get(path);
    if (!handler) {
      response.writeHead(404);
      response.end('missing');
      return;
    }
    handler(request, response);
  });
  server.on('connection', (socket) => {
    accepted++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    connections: () => accepted,
    route: (path, handler) => {
      routes.set(path, handler);
    },
    serve: (path, body, contentType = 'image/png') => {
      routes.set(path, (_request, response) => {
        // The exact length, as a real image host sends it.
        response.writeHead(200, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) });
        response.end(body);
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

export function solidPng(width: number, height: number, rgb: { r: number; g: number; b: number }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: rgb } }).png().toBuffer();
}

export function noisyJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + (i >> 5) * 11) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 90, chromaSubsampling: '4:4:4' }).toBuffer();
}
