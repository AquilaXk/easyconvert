import http from 'node:http';
import { loadConfig } from '../config';
import { instruments } from './instruments';

/**
 * The scrape endpoint of a process: GET /metrics on a port of its own, on the container's network only. It is a listener apart from
 * the web application's, so the reverse proxy in front of the web port has no route to it and the compose file publishes neither port
 * (tests/metrics-exposure.test.ts). The metrics hold counts and timings under closed labels (src/lib/metrics/labels.ts), nothing
 * of a request, but they are not for the public all the same.
 */

const WEB_DEFAULT_PORT = 9464;
const WORKER_DEFAULT_PORT = 9465;
export const METRICS_PATH = '/metrics';
export const DEFAULT_METRICS_HOST = '127.0.0.1';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;
const REQUEST_TIMEOUT_MS = 10_000;
const HEADERS_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;

export type MetricsRole = 'web' | 'worker';

export function defaultMetricsPort(role: MetricsRole): number {
  return role === 'web' ? WEB_DEFAULT_PORT : WORKER_DEFAULT_PORT;
}

export interface MetricsServerOptions {
  /** The port to listen on; `0` asks the system for a free one (tests). */
  port: number;
  host: string;
  /** Runs before each scrape is answered, to read values that live elsewhere (the queue). */
  beforeScrape?: () => Promise<void>;
}

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

async function answer(options: MetricsServerOptions, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0];
  if (path !== METRICS_PATH) {
    res.writeHead(HTTP_NOT_FOUND).end();
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(HTTP_METHOD_NOT_ALLOWED, { Allow: 'GET' }).end();
    return;
  }
  try {
    await options.beforeScrape?.();
    const { registry } = instruments();
    const body = await registry.metrics();
    res.writeHead(HTTP_OK, { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' }).end(body);
  } catch {
    // No detail: the answer of an error is not for whoever asked.
    res.writeHead(HTTP_SERVER_ERROR).end();
  }
}

/** Starts the listener. Resolves undefined, after a warning, when the port cannot be taken: a process without metrics still serves. */
export function startMetricsServer(options: MetricsServerOptions): Promise<MetricsServer | undefined> {
  const server = http.createServer((req, res) => {
    void answer(options, req, res);
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return new Promise((resolve) => {
    const notListening = (error: NodeJS.ErrnoException) => {
      console.warn(`[metrics] not listening on ${options.host}:${options.port}: ${error.code ?? error.name}`);
      resolve(undefined);
    };
    server.once('error', notListening);
    server.listen(options.port, options.host, () => {
      // Once listening, an error (an accept that fails when descriptors run out) is logged and the process keeps serving.
      server.off('error', notListening);
      server.on('error', (error: NodeJS.ErrnoException) => {
        console.warn(`[metrics] listener error on ${options.host}:${options.port}: ${error.code ?? error.name}`);
      });
      server.unref();
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        port,
        stop: () =>
          new Promise<void>((done) => {
            const forced = setTimeout(() => {
              server.closeAllConnections();
              done();
            }, STOP_TIMEOUT_MS);
            server.close(() => {
              clearTimeout(forced);
              done();
            });
          }),
      });
    });
  });
}

const STARTED_KEY = Symbol.for('easyconvert.metrics.server');

/**
 * Starts the listener of a process from its configuration (METRICS_PORT, METRICS_HOST), once per process. Does nothing when the
 * port is `0`.
 */
export async function startMetricsFromConfig(role: MetricsRole, beforeScrape?: () => Promise<void>): Promise<MetricsServer | undefined> {
  const holder = globalThis as { [STARTED_KEY]?: boolean };
  if (holder[STARTED_KEY]) return undefined;
  const config = loadConfig(process.env, { role });
  const port = config.METRICS_PORT ?? defaultMetricsPort(role);
  if (port === 0) return undefined;
  holder[STARTED_KEY] = true;
  return startMetricsServer({ port, host: config.METRICS_HOST ?? DEFAULT_METRICS_HOST, beforeScrape });
}
