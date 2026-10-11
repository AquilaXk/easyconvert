import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_FETCH_LIMITS,
  ImageFetchRefusal,
  ImageFetchSession,
  overrideImageFetchEnvironment,
  type ImageFetchEnvironment,
} from '../src/lib/conversions/html-image-fetch';
import { noisyJpeg, solidPng, startImageServer, type ImageServer } from './helpers/image-server';

/**
 * The fetcher behind HTML image loading. A local server on 127.0.0.1 stands in for a public host: the tests replace the
 * resolver (host name -> address) and let that one loopback address through, so no real name server or network is used.
 * Without an override the production rules apply, which refuse loopback.
 */

const LOOPBACK = '127.0.0.1';
const PUBLIC_HOST = 'images.test';
const SECOND_HOST = 'second.test';
const PRIVATE_HOST = 'internal.test';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let server: ImageServer;
let restore: (() => void) | undefined;
let resolveCalls: string[];
let png: Buffer;

/** Host names the tests use, and the addresses their resolver answers. */
function hostTable(extra: Record<string, string[]> = {}): Record<string, string[]> {
  return { [PUBLIC_HOST]: [LOOPBACK], [SECOND_HOST]: [LOOPBACK], [PRIVATE_HOST]: ['10.0.0.5'], ...extra };
}

function install(environment: Partial<ImageFetchEnvironment> & { hosts?: Record<string, string[]> } = {}): void {
  const { hosts, ...rest } = environment;
  const table = hosts ?? hostTable();
  restore?.();
  restore = overrideImageFetchEnvironment({
    resolve: async (host) => {
      resolveCalls.push(host);
      const answer = table[host];
      if (!answer) throw new Error(`no such host ${host}`);
      return answer;
    },
    // Only the one loopback address of the test server counts as reachable; every other class keeps the production answer.
    permitAddress: (address) => address === LOOPBACK,
    permitPort: () => true,
    ...rest,
  });
}

const url = (host: string, path: string, port = server.port): string => `http://${host}:${port}${path}`;

async function refusal(promise: Promise<unknown>): Promise<ImageFetchRefusal> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(ImageFetchRefusal);
  return error as ImageFetchRefusal;
}

let connectSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  server = await startImageServer();
  resolveCalls = [];
  png = await solidPng(4, 3, { r: 200, g: 30, b: 30 });
  server.serve('/a.png', png);
  install();
  connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
});

afterEach(async () => {
  connectSpy.mockRestore();
  restore?.();
  restore = undefined;
  await server.close();
});

describe('a public image is fetched', () => {
  it('returns the bytes and the type taken from the signature', async () => {
    const fetched = await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png'));
    expect(fetched.bytes.equals(png)).toBe(true);
    expect(fetched.mime).toBe('image/png');
  });

  it('sends no cookies, credentials, referrer or compression, and the host name in Host', async () => {
    await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png'));
    const headers = server.requests[0].headers;
    expect(headers.host).toBe(`${PUBLIC_HOST}:${server.port}`);
    expect(headers['accept-encoding']).toBe('identity');
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'referer', 'origin']) expect(headers[name]).toBeUndefined();
  });

  it.each([
    ['JPEG', async () => noisyJpeg(16, 16), 'image/jpeg'],
    ['GIF', async () => Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), 'image/gif'],
    ['WebP', async () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).webp().toBuffer(), 'image/webp'],
  ])('accepts %s', async (_name, build, mime) => {
    const body = await build();
    server.serve('/x', body, mime);
    const fetched = await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/x'));
    expect(fetched.mime).toBe(mime);
    expect(fetched.bytes.equals(body)).toBe(true);
  });

  it('accepts an image served as application/octet-stream, since the signature decides', async () => {
    server.serve('/blob', png, 'application/octet-stream');
    expect((await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/blob'))).mime).toBe('image/png');
  });

  it('asks for the same URL once per session', async () => {
    const session = new ImageFetchSession();
    await Promise.all([session.fetch(url(PUBLIC_HOST, '/a.png')), session.fetch(url(PUBLIC_HOST, '/a.png'))]);
    expect(server.requests).toHaveLength(1);
  });

  it('does not use a proxy named in the environment', async () => {
    const proxy = http.createServer((_request, response) => response.end());
    let proxied = 0;
    proxy.on('connection', () => proxied++);
    await new Promise<void>((resolve) => proxy.listen(0, LOOPBACK, resolve));
    const proxyUrl = `http://${LOOPBACK}:${(proxy.address() as AddressInfo).port}`;
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    vi.stubEnv('http_proxy', proxyUrl);
    vi.stubEnv('HTTPS_PROXY', proxyUrl);
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    try {
      await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png'));
    } finally {
      vi.unstubAllEnvs();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
    expect(proxied).toBe(0);
    expect(server.requests).toHaveLength(1);
  });
});

describe('production rules without any override', () => {
  beforeEach(() => {
    restore?.();
    // Only the port rule is relaxed so the local server can be addressed; the address rule is the production one.
    restore = overrideImageFetchEnvironment({ permitPort: () => true });
  });

  it.each([
    [`http://${LOOPBACK}:PORT/a.png`],
    ['http://localhost:PORT/a.png'],
    ['http://[::1]:PORT/a.png'],
    ['http://2130706433:PORT/a.png'],
    ['http://0x7f.1:PORT/a.png'],
    ['http://017700000001:PORT/a.png'],
    ['http://[::ffff:127.0.0.1]:PORT/a.png'],
    ['http://127.1:PORT/a.png'],
  ])('refuses loopback written as %s without connecting', async (template) => {
    const error = await refusal(new ImageFetchSession().fetch(template.replace('PORT', String(server.port))));
    expect(error.message).toMatch(/not a public address|not allowed/);
    expect(server.connections()).toBe(0);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('refuses a port other than 80 and 443', async () => {
    restore?.();
    restore = overrideImageFetchEnvironment({ permitAddress: (address) => address === LOOPBACK, resolve: async () => [LOOPBACK] });
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png')));
    expect(error.message).toMatch(/port/);
    expect(server.connections()).toBe(0);
  });
});

describe('addresses that are refused', () => {
  const PRIVATE_ANSWERS: Array<[name: string, answer: string[]]> = [
    ['private 10/8', ['10.1.2.3']],
    ['private 172.16/12', ['172.20.0.1']],
    ['private 192.168/16', ['192.168.1.1']],
    ['carrier-grade NAT', ['100.64.0.1']],
    ['link-local cloud metadata', ['169.254.169.254']],
    ['this network 0.0.0.0/8', ['0.0.0.0']],
    ['multicast', ['224.0.0.1']],
    ['reserved 240/4', ['240.0.0.1']],
    ['IPv6 loopback', ['::1']],
    ['IPv6 unique local metadata', ['fd00:ec2::254']],
    ['IPv6 link-local', ['fe80::1']],
    ['IPv4-mapped loopback', ['::ffff:127.0.0.1']],
    ['IPv4-mapped private', ['::ffff:10.0.0.1']],
    ['IPv4-compatible', ['::10.0.0.1']],
    ['NAT64 of a public address', ['64:ff9b::808:808']],
    ['6to4', ['2002:7f00:1::1']],
    ['one private among public answers', ['8.8.8.8', '10.0.0.9']],
    ['private first, public after', ['10.0.0.9', '8.8.8.8']],
  ];

  it.each(PRIVATE_ANSWERS)('refuses a host that resolves to %s, and connects to nothing', async (_name, answer) => {
    restore?.();
    restore = overrideImageFetchEnvironment({
      resolve: async (host) => {
        resolveCalls.push(host);
        return answer;
      },
      permitPort: () => true,
    });
    const error = await refusal(new ImageFetchSession().fetch(url('rebound.test', '/a.png')));
    expect(error.message).toMatch(/not a public address/);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(server.connections()).toBe(0);
  });

  it.each([
    'http://10.0.0.1/a.png',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[::ffff:a00:1]/a.png',
    'http://100.100.100.200/latest/meta-data/',
    'http://0.0.0.0/a.png',
    'http://[::]/a.png',
    'http://192.168.0.1/a.png',
  ])('refuses the address literal %s without resolving or connecting', async (literal) => {
    const error = await refusal(new ImageFetchSession().fetch(literal));
    expect(error.message).toMatch(/not a public address/);
    expect(resolveCalls).toEqual([]);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it.each(['localhost', 'app.localhost', 'metadata.google.internal', 'printer.local', 'intranet', 'instance-data', 'router.lan', 'host.home.arpa', 'LOCALHOST.'])(
    'refuses the host name %s without resolving it',
    async (host) => {
      const error = await refusal(new ImageFetchSession().fetch(url(host, '/a.png')));
      expect(error.message).toMatch(/not allowed|not a public address/);
      expect(resolveCalls).toEqual([]);
      expect(connectSpy).not.toHaveBeenCalled();
    }
  );

  it('refuses a host the resolver cannot resolve', async () => {
    const error = await refusal(new ImageFetchSession().fetch(url('nowhere.test', '/a.png')));
    expect(error.message).toMatch(/could not be resolved/);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it.each(['file:///etc/hosts', 'ftp://images.test/a.png', 'gopher://images.test/', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//images.test/a.png', 'http:images.test/a.png', 'http:/images.test/a.png', 'a.png', ''])(
    'refuses %j, which is not an absolute http or https URL',
    async (reference) => {
      const error = await refusal(new ImageFetchSession().fetch(reference));
      expect(error.message).toMatch(/http or https/);
      expect(connectSpy).not.toHaveBeenCalled();
    }
  );

  it.each(['http://user:secret@images.test/a.png', 'http://user@images.test/a.png'])('refuses credentials in %s', async (withCredentials) => {
    const error = await refusal(new ImageFetchSession().fetch(withCredentials.replace('images.test', `images.test:${server.port}`)));
    expect(error.message).toMatch(/credentials/);
    expect(server.connections()).toBe(0);
  });
});

describe('DNS rebinding', () => {
  it('connects to the address that was checked and never asks again', async () => {
    let answers = 0;
    install({
      resolve: async (host) => {
        resolveCalls.push(host);
        answers++;
        return answers === 1 ? [LOOPBACK] : ['10.0.0.5'];
      },
    });
    const fetched = await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png'));
    expect(fetched.bytes.equals(png)).toBe(true);
    expect(resolveCalls).toEqual([PUBLIC_HOST]);
    expect(server.connections()).toBe(1);
  });

  it('refuses when the first answer is private even though a later answer would be public', async () => {
    let answers = 0;
    restore?.();
    restore = overrideImageFetchEnvironment({
      resolve: async () => {
        answers++;
        return answers === 1 ? ['10.0.0.5'] : [LOOPBACK];
      },
      permitAddress: (address) => address === LOOPBACK,
      permitPort: () => true,
    });
    await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png')));
    expect(answers).toBe(1);
    expect(server.connections()).toBe(0);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('refuses a connection whose peer is not an address that was checked', async () => {
    let checks = 0;
    install({
      permitAddress: (address) => {
        checks++;
        return checks === 1 && address === LOOPBACK;
      },
    });
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png')));
    expect(error.message).toMatch(/not a public address/);
    expect(server.requests).toHaveLength(0);
  });
});

describe('redirects', () => {
  const redirect = (to: string, status = 302): ((request: http.IncomingMessage, response: http.ServerResponse) => void) => (_request, response) => {
    response.writeHead(status, { location: to });
    response.end();
  };

  it.each([301, 302, 303, 307, 308])('follows a %i redirect and checks the new host again', async (status) => {
    server.route('/go', redirect(url(SECOND_HOST, '/a.png'), status));
    const fetched = await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/go'));
    expect(fetched.bytes.equals(png)).toBe(true);
    expect(resolveCalls).toEqual([PUBLIC_HOST, SECOND_HOST]);
  });

  it('follows a relative Location', async () => {
    server.route('/go', redirect('/a.png'));
    expect((await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/go'))).bytes.equals(png)).toBe(true);
  });

  it('follows three hops and refuses a fourth', async () => {
    server.route('/h1', redirect('/h2'));
    server.route('/h2', redirect('/h3'));
    server.route('/h3', redirect('/a.png'));
    server.route('/h4', redirect('/h5'));
    server.route('/h5', redirect('/h6'));
    server.route('/h6', redirect('/h7'));
    server.route('/h7', redirect('/a.png'));
    expect((await new ImageFetchSession().fetch(url(PUBLIC_HOST, '/h1'))).bytes.equals(png)).toBe(true);
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/h4')));
    expect(error.message).toMatch(/redirect/);
    expect(IMAGE_FETCH_LIMITS.maxRedirects).toBe(3);
  });

  it('refuses a redirect loop', async () => {
    server.route('/loop', redirect('/loop'));
    expect((await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/loop')))).message).toMatch(/redirect/);
  });

  it('refuses a redirect to a host that resolves to a private address, without connecting to it', async () => {
    server.route('/go', redirect(url(PRIVATE_HOST, '/a.png')));
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/go')));
    expect(error.message).toMatch(/not a public address/);
    expect(resolveCalls).toEqual([PUBLIC_HOST, PRIVATE_HOST]);
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/a.png',
    'http://localhost/a.png',
    'http://user:pass@second.test/a.png',
    'file:///etc/passwd',
    'ftp://second.test/a.png',
    'gopher://second.test/',
  ])('refuses a redirect to %s', async (target) => {
    server.route('/go', redirect(target.replace('second.test', `second.test:${server.port}`)));
    await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/go')));
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses a redirect without a Location', async () => {
    server.route('/go', (_request, response) => {
      response.writeHead(302);
      response.end();
    });
    await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/go')));
  });
});

describe('what the response may be', () => {
  it('refuses an image whose declared length is above the per-image cap, before reading it', async () => {
    const body = Buffer.alloc(2048, 1);
    server.route('/big', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(IMAGE_FETCH_LIMITS.maxImageBytes + 1) });
      response.write(body);
    });
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/big')));
    expect(error.message).toMatch(/larger than/);
  });

  it('stops reading a body that grows past the cap without announcing its length', async () => {
    let sent = 0;
    server.route('/stream', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      const chunk = Buffer.concat([PNG_MAGIC, Buffer.alloc(64 * 1024)]);
      const timer = setInterval(() => {
        if (response.destroyed || sent > 400 * 1024 * 1024) {
          clearInterval(timer);
          return;
        }
        sent += chunk.length;
        response.write(chunk);
      }, 0);
      response.on('close', () => clearInterval(timer));
    });
    const error = await refusal(new ImageFetchSession({ maxImageBytes: 256 * 1024 }).fetch(url(PUBLIC_HOST, '/stream')));
    expect(error.message).toMatch(/larger than/);
    expect(sent).toBeLessThan(64 * 1024 * 1024);
  });

  it('refuses images past the total size across a session', async () => {
    server.serve('/one.png', png);
    const session = new ImageFetchSession({ maxTotalBytes: png.length + 10 });
    await session.fetch(url(PUBLIC_HOST, '/a.png'));
    const error = await refusal(session.fetch(url(PUBLIC_HOST, '/one.png')));
    expect(error.message).toMatch(/total size/);
  });

  it.each([
    ['an HTML page', '<html><body>nope</body></html>', 'text/html'],
    ['HTML under an image type', '<html><body>nope</body></html>', 'image/png'],
    ['SVG', '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 'image/svg+xml'],
    ['text under an image type', 'GIF', 'image/gif'],
    ['an empty body', '', 'image/png'],
    ['a PNG under a text type', PNG_MAGIC, 'text/plain'],
  ])('refuses %s', async (_name, body, type) => {
    server.serve('/x', body as Buffer | string, type);
    const error = await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/x')));
    expect(error.message).toMatch(/PNG, JPEG, GIF or WebP/);
  });

  it('refuses a compressed response, which could expand past the cap', async () => {
    server.route('/gz', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' });
      response.end(png);
    });
    expect((await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/gz')))).message).toMatch(/compressed/);
  });

  it.each([404, 403, 500, 204, 206])('refuses the status %i', async (status) => {
    server.route('/s', (_request, response) => {
      response.writeHead(status);
      response.end();
    });
    expect((await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/s')))).message).toContain(`status ${status}`);
  });

  it('refuses a server that cannot be reached', async () => {
    const closed = await startImageServer();
    const port = closed.port;
    await closed.close();
    expect((await refusal(new ImageFetchSession().fetch(url(PUBLIC_HOST, '/a.png', port)))).message).toMatch(/could not be reached/);
  });
});

describe('time limits', () => {
  it('refuses a server that never answers after the per-fetch time', async () => {
    server.route('/hang', () => undefined);
    const started = Date.now();
    const error = await refusal(new ImageFetchSession({ perFetchMs: 300, totalMs: 5000 }).fetch(url(PUBLIC_HOST, '/hang')));
    expect(error.message).toMatch(/too long/);
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('refuses a body that trickles in too slowly', async () => {
    server.route('/trickle', (_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.write(PNG_MAGIC);
      const timer = setInterval(() => response.write(Buffer.alloc(8)), 40);
      response.on('close', () => clearInterval(timer));
    });
    const error = await refusal(new ImageFetchSession({ perFetchMs: 400, totalMs: 5000 }).fetch(url(PUBLIC_HOST, '/trickle')));
    expect(error.message).toMatch(/too long/);
  });

  it('shares one total time across the fetches of a session', async () => {
    server.route('/hang', () => undefined);
    const session = new ImageFetchSession({ perFetchMs: 5000, totalMs: 400 });
    const started = Date.now();
    await refusal(session.fetch(url(PUBLIC_HOST, '/hang')));
    expect(Date.now() - started).toBeLessThan(2500);
    const error = await refusal(session.fetch(url(PUBLIC_HOST, '/a.png')));
    expect(error.message).toMatch(/too long/);
  });

  it('states the limits the document describes', () => {
    expect(IMAGE_FETCH_LIMITS).toMatchObject({
      maxImageBytes: 10 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
      maxImages: 100,
      perFetchMs: 10_000,
      totalMs: 30_000,
      maxRedirects: 3,
    });
  });
});

describe('count limit', () => {
  it('fetches 100 distinct images and refuses the 101st without contacting the server', async () => {
    const session = new ImageFetchSession();
    for (let i = 0; i < 100; i++) await session.fetch(url(PUBLIC_HOST, `/a.png?n=${i}`));
    const before = server.requests.length;
    const error = await refusal(session.fetch(url(PUBLIC_HOST, '/a.png?n=100')));
    expect(error.message).toMatch(/100 images/);
    expect(server.requests).toHaveLength(before);
  });

  it('counts a refused fetch too', async () => {
    const session = new ImageFetchSession({ maxImages: 2 });
    await refusal(session.fetch(url(PUBLIC_HOST, '/missing')));
    await refusal(session.fetch(url(PUBLIC_HOST, '/missing2')));
    expect((await refusal(session.fetch(url(PUBLIC_HOST, '/a.png')))).message).toMatch(/2 images/);
  });
});
