import http from 'node:http';
import net from 'node:net';
import { isBlockedIp, ssrfSafeLookup } from './ssrf';

/**
 * The gate every network request of a website capture goes through. The browser that renders the page is started with this proxy as
 * its only route (and with no resolver of its own), so each navigation, each redirect it follows, each image, script, frame and
 * fetch the page makes arrives here as a CONNECT (for HTTPS, WebSocket and anything else it tunnels) or as an absolute-URI request
 * (plain HTTP), and nothing reaches the network without passing the checks below:
 *
 * - Only HTTP and HTTPS ports (80 and 443). Methods and request forms a proxy has no use for are refused.
 * - The host is resolved here, once, through `ssrfSafeLookup` (the guard of every other outbound request of the project: a restricted
 *   name, a numeric host in any form, and any answer in a private, loopback, link-local, metadata, documentation, multicast or
 *   otherwise non-global range, with every IPv6 form that carries an IPv4 address, refuse the whole request). The connection is then
 *   made to the address that check returned, by address, so the name is never resolved a second time and a name server that changes
 *   its answer between the check and the connect (DNS rebinding) is not asked again. The peer address of the connected socket is
 *   checked once more.
 * - A redirect is never followed here: the 3xx answer goes back to the browser, which asks for the new address through this gate
 *   again, so every hop is checked like the first.
 * - Per capture: a cap on open connections, on the bytes relayed, and an idle time for each socket. The gate listens on the loopback
 *   interface only.
 */

const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const FORBIDDEN = 403;
const BAD_REQUEST = 400;
const BAD_GATEWAY = 502;
const REFUSAL_HEADER = 'x-capture-gate';
const MAX_RECORDED_REFUSALS = 100;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_IDLE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_PORT = 65_535;
/** `host:port` of a CONNECT: a name or an IPv4 address, or an IPv6 address in brackets; no user information, path or whitespace. */
const AUTHORITY = /^(\[[0-9a-fA-F:.]+(?:%[0-9A-Za-z._~-]+)?\]|[^\s:@/\\?#[\]]+):(\d{1,5})$/;
const HOP_BY_HOP: ReadonlySet<string> = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'keep-alive', 'te', 'trailer', 'upgrade']);

/** Why the gate refused a request. */
export type GateRefusalReason =
  | 'malformed' // the request is not one a proxy serves (no authority, credentials in the address, a path where an address belongs)
  | 'method' // not CONNECT and not a request with an absolute http URL
  | 'scheme' // an absolute URL that is not http
  | 'port' // a port other than 80 and 443
  | 'blocked' // a restricted host, or an answer in a restricted range
  | 'unresolved' // the name has no address
  | 'limit' // too many connections or too many bytes
  | 'peer'; // the socket connected to an address the check did not return

export interface GateRefusal {
  host: string;
  port: number;
  reason: GateRefusalReason;
}

/** The address a request was vetted to and is connected to. */
export interface GateTarget {
  address: string;
  family: number;
  port: number;
}

/** Parts of the checks and of the connection that a test replaces; the product uses the defaults. */
export interface CaptureGateOptions {
  lookup?: net.LookupFunction;
  permitPort?: (port: number) => boolean;
  dial?: (target: GateTarget) => net.Socket;
  maxConnections?: number;
  maxBytes?: number;
  idleMs?: number;
}

export interface CaptureGate {
  /** The loopback port of the proxy, for the browser's `--proxy-server`. */
  readonly port: number;
  /** Every refusal so far (the first 100), in order. */
  readonly refusals: readonly GateRefusal[];
  /** Bytes relayed in both directions. */
  bytes(): number;
  /** Connections and requests the gate passed on. */
  readonly passed: readonly GateTarget[];
  close(): Promise<void>;
}

class GateError extends Error {
  constructor(readonly reason: GateRefusalReason) {
    super(reason);
  }
}

const defaultPermitPort = (port: number): boolean => port === HTTP_PORT || port === HTTPS_PORT;

function defaultDial(target: GateTarget): net.Socket {
  const socket = net.connect({ host: target.address, port: target.port, family: target.family });
  socket.once('connect', () => {
    // The check ran on the answer of the name server; the socket must be at that address (and so at a public one).
    const peer = socket.remoteAddress ?? '';
    if (isBlockedIp(peer) || peer.toLowerCase() !== target.address.toLowerCase()) socket.destroy(new GateError('peer'));
  });
  return socket;
}

function lookupAll(lookup: net.LookupFunction, host: string): Promise<GateTarget[]> {
  return new Promise((resolve, reject) => {
    lookup(host, { all: true }, (error, addresses) => {
      if (error) {
        const refused = (error as NodeJS.ErrnoException).code === 'ESSRFBLOCKED' && !/could not resolve/.test(error.message);
        reject(new GateError(refused ? 'blocked' : 'unresolved'));
        return;
      }
      const list = (Array.isArray(addresses) ? addresses : []) as Array<{ address: string; family: number }>;
      if (list.length === 0) reject(new GateError('unresolved'));
      else resolve(list.map(({ address, family }) => ({ address, family, port: 0 })));
    });
  });
}

function bareHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export async function startCaptureGate(options: CaptureGateOptions = {}): Promise<CaptureGate> {
  const lookup = options.lookup ?? ssrfSafeLookup;
  const permitPort = options.permitPort ?? defaultPermitPort;
  const dial = options.dial ?? defaultDial;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  const refusals: GateRefusal[] = [];
  const passed: GateTarget[] = [];
  const open = new Set<net.Socket>();
  /** The browser's own connections to the gate, which the cap on connections counts (each tunnel also holds one upstream socket). */
  const clients = new Set<net.Socket>();
  let relayed = 0;
  let closed = false;

  const refuse = (host: string, port: number, reason: GateRefusalReason): void => {
    if (refusals.length < MAX_RECORDED_REFUSALS) refusals.push({ host, port, reason });
  };

  /** The address a request to `host:port` is connected to, or a GateError saying why not. Resolves once. */
  async function vet(host: string, port: number): Promise<GateTarget> {
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT || !permitPort(port)) throw new GateError('port');
    if (clients.size > maxConnections || relayed > maxBytes) throw new GateError('limit');
    const [first] = await lookupAll(lookup, bareHost(host));
    return { address: first.address, family: first.family, port };
  }

  function track(socket: net.Socket): void {
    open.add(socket);
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      relayed += chunk.length;
      if (relayed > maxBytes) {
        refuse('(relay)', 0, 'limit');
        for (const live of open) live.destroy();
      }
    });
    socket.once('close', () => open.delete(socket));
  }

  const server = http.createServer();
  server.on('connection', (socket: net.Socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
  });

  server.on('connect', (request, clientSocket: net.Socket, head: Buffer) => {
    track(clientSocket);
    clientSocket.on('error', () => clientSocket.destroy());
    const match = AUTHORITY.exec(request.url ?? '');
    const host = match?.[1] ?? '';
    const port = match ? Number(match[2]) : 0;
    const deny = (reason: GateRefusalReason): void => {
      refuse(host || '(none)', port, reason);
      clientSocket.end(`HTTP/1.1 ${reason === 'malformed' ? BAD_REQUEST : FORBIDDEN} Refused\r\n${REFUSAL_HEADER}: ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!match) {
      deny('malformed');
      return;
    }
    vet(host, port).then(
      (target) => {
        if (closed || clientSocket.destroyed) return;
        passed.push(target);
        const upstream = dial(target);
        track(upstream);
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.once('connect', () => {
          if (upstream.destroyed) return;
          upstream.setTimeout(idleMs, () => upstream.destroy());
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', (error) => {
          if (error instanceof GateError) refuse(host, port, error.reason);
          if (!clientSocket.destroyed && clientSocket.writable && !clientSocket.bytesWritten) {
            clientSocket.end(`HTTP/1.1 ${BAD_GATEWAY} Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
          }
          clientSocket.destroy();
        });
        upstream.once('close', () => clientSocket.destroy());
        clientSocket.once('close', () => upstream.destroy());
      },
      (error: unknown) => deny(error instanceof GateError ? error.reason : 'unresolved')
    );
  });

  server.on('request', (request, response) => {
    const deny = (host: string, port: number, reason: GateRefusalReason): void => {
      refuse(host || '(none)', port, reason);
      response.writeHead(reason === 'malformed' ? BAD_REQUEST : FORBIDDEN, { [REFUSAL_HEADER]: reason, 'content-length': '0', connection: 'close' });
      response.end();
    };
    let url: URL;
    try {
      url = new URL(request.url ?? '');
    } catch {
      deny('', 0, request.url?.startsWith('/') ? 'method' : 'malformed');
      return;
    }
    const port = url.port === '' ? HTTP_PORT : Number(url.port);
    if (url.protocol !== 'http:') {
      deny(url.hostname, port, 'scheme');
      return;
    }
    if (url.username !== '' || url.password !== '') {
      deny(url.hostname, port, 'malformed');
      return;
    }
    vet(url.hostname, port).then(
      (target) => {
        if (closed) return;
        passed.push(target);
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (!HOP_BY_HOP.has(name) && name !== 'host') headers[name] = value;
        }
        headers.host = url.host;
        const upstream = http.request({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          headers,
          // No agent: the request is made on the socket `dial` returns (an agent would open its own, by the name).
          createConnection: () => {
            const socket = dial(target);
            track(socket);
            return socket;
          },
        });
        upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
        upstream.on('response', (answer) => {
          const answerHeaders: http.OutgoingHttpHeaders = {};
          for (const [name, value] of Object.entries(answer.headers)) {
            if (!HOP_BY_HOP.has(name)) answerHeaders[name] = value;
          }
          response.writeHead(answer.statusCode ?? BAD_GATEWAY, answerHeaders);
          answer.pipe(response);
        });
        upstream.on('error', (error) => {
          if (error instanceof GateError) refuse(url.hostname, port, error.reason);
          if (!response.headersSent) response.writeHead(BAD_GATEWAY, { 'content-length': '0', connection: 'close' });
          response.end();
        });
        request.pipe(upstream);
      },
      (error: unknown) => deny(url.hostname, port, error instanceof GateError ? error.reason : 'unresolved')
    );
  });

  server.on('upgrade', (_request, socket: net.Socket) => {
    refuse('(upgrade)', 0, 'method');
    socket.end(`HTTP/1.1 ${FORBIDDEN} Refused\r\n${REFUSAL_HEADER}: method\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.on('clientError', (_error, socket) => {
    refuse('(none)', 0, 'malformed');
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    refusals,
    passed,
    bytes: () => relayed,
    async close() {
      closed = true;
      for (const socket of open) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
