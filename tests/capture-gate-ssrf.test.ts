import dns, { type LookupAddress } from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startCaptureGate, type CaptureGate, type CaptureGateOptions, type GateTarget } from '../src/lib/security/capture-gate';

/**
 * The SSRF suite of the website capture. The browser reaches the network only through the gate, so every path a page has to an
 * address (the navigation, a redirect it follows, a subresource, a frame, a fetch, a WebSocket) is one of the two request forms
 * the gate serves: CONNECT for anything tunnelled (HTTPS, WebSocket) and an absolute-URI request for plain HTTP. These tests send
 * both forms for every address and name of the lists below, with the real guard (`ssrfSafeLookup`) and a name server whose answers
 * the test chooses, and assert that nothing is dialled for a refused request.
 */

const PUBLIC_V4 = '93.184.216.34';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
const HTTPS_PORT = 443;
const HTTP_PORT = 80;

/** Addresses a page must never reach, as an IP literal in a URL. */
const BLOCKED_ADDRESSES: Array<[string, string]> = [
  ['loopback', '127.0.0.1'],
  ['loopback, other host bits', '127.1.2.3'],
  ['this network', '0.0.0.0'],
  ['private 10/8', '10.0.0.1'],
  ['private 172.16/12 low', '172.16.0.1'],
  ['private 172.16/12 high', '172.31.255.255'],
  ['private 192.168/16', '192.168.1.1'],
  ['link-local, cloud metadata', '169.254.169.254'],
  ['link-local, container task metadata', '169.254.170.2'],
  ['carrier-grade NAT', '100.64.0.1'],
  ['carrier-grade NAT, a metadata address of a cloud', '100.100.100.200'],
  ['protocol assignments', '192.0.0.192'],
  ['benchmarking', '198.18.0.1'],
  ['documentation', '192.0.2.1'],
  ['multicast', '224.0.0.1'],
  ['reserved', '240.0.0.1'],
  ['broadcast', '255.255.255.255'],
  ['IPv6 loopback', '[::1]'],
  ['IPv6 unspecified', '[::]'],
  ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'],
  ['IPv4-mapped loopback in hexadecimal', '[::ffff:7f00:1]'],
  ['IPv4-mapped metadata', '[::ffff:a9fe:a9fe]'],
  ['IPv4-mapped, long form', '[0:0:0:0:0:ffff:127.0.0.1]'],
  ['IPv4-compatible loopback', '[::127.0.0.1]'],
  ['NAT64 loopback', '[64:ff9b::7f00:1]'],
  ['NAT64 metadata', '[64:ff9b::a9fe:a9fe]'],
  ['6to4 loopback', '[2002:7f00:1::]'],
  ['6to4 metadata', '[2002:a9fe:a9fe::1]'],
  ['Teredo', '[2001::1]'],
  ['IPv6 documentation', '[2001:db8::1]'],
  ['IPv6 link-local', '[fe80::1]'],
  ['IPv6 link-local with a zone', '[fe80::1%eth0]'],
  ['IPv6 unique local', '[fc00::1]'],
  ['IPv6 unique local, cloud metadata', '[fd00:ec2::254]'],
  ['IPv6 multicast', '[ff02::1]'],
];

/** A host that is an IPv4 address written in a form `inet_aton` accepts, or a name that stands for an internal host. */
const BLOCKED_HOSTS: Array<[string, string]> = [
  ['decimal integer loopback', '2130706433'],
  ['hexadecimal loopback', '0x7f000001'],
  ['octal loopback', '0177.0.0.1'],
  ['short loopback', '127.1'],
  ['mixed hexadecimal loopback', '0x7f.1'],
  ['octal integer loopback', '017700000001'],
  ['decimal integer metadata', '2852039166'],
  ['localhost', 'localhost'],
  ['localhost in capitals', 'LOCALHOST'],
  ['localhost with a trailing dot', 'localhost.'],
  ['a name under localhost', 'app.localhost'],
  ['the metadata name of a cloud', 'metadata.google.internal'],
  ['the short metadata name', 'metadata'],
  ['the instance data name', 'instance-data'],
  ['a name under .internal', 'db.internal'],
  ['a name under .local', 'printer.local'],
  ['a name under .lan', 'router.lan'],
  ['a name under .corp', 'wiki.corp'],
  ['a name under .home', 'nas.home'],
  ['a name under .test', 'service.test'],
  ['a name under .arpa', '1.0.0.127.in-addr.arpa'],
  ['an onion name', 'hidden.onion'],
];

const BLOCKED_PORTS = [0, 21, 22, 25, 53, 3306, 5432, 6379, 8080, 8443, 9200, 65535, 65536, 99999];

interface Answer {
  status: string;
  headers: Record<string, string>;
}

let gate: CaptureGate | undefined;
const dialed: GateTarget[] = [];
const upstreamServers: http.Server[] = [];

/**
 * A name server that answers with `addresses` for any name, and the names it was asked for. A literal address is not a name: the
 * sockets of this test (the gate and its upstream servers listen on 127.0.0.1) are resolved by the real function.
 */
function nameServer(addresses: LookupAddress[] | ((name: string, call: number) => LookupAddress[])) {
  const asked: string[] = [];
  const realLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((name: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, list: LookupAddress[]) => void) => {
    if (net.isIP(name) !== 0) return (realLookup as (...args: unknown[]) => void)(name, options, callback);
    asked.push(name);
    const list = typeof addresses === 'function' ? addresses(name, asked.length) : addresses;
    process.nextTick(() => callback(null, list));
  }) as never);
  return asked;
}

/** The gate with a dial that records the address it is given and connects to `upstreamPort` of this machine instead of the Internet. */
async function openGate(options: CaptureGateOptions = {}, upstreamPort?: number): Promise<CaptureGate> {
  gate = await startCaptureGate({
    dial: (target) => {
      dialed.push(target);
      return net.connect({ host: '127.0.0.1', port: upstreamPort ?? 9 });
    },
    ...options,
  });
  return gate;
}

function readAnswer(socket: net.Socket): Promise<Answer> {
  return new Promise((resolve, reject) => {
    let text = '';
    socket.on('data', (chunk: Buffer) => {
      text += chunk.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end >= 0) {
        const [statusLine, ...lines] = text.slice(0, end).split('\r\n');
        resolve({ status: statusLine, headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()])) });
        socket.destroy();
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve({ status: text.split('\r\n')[0] ?? '', headers: {} }));
  });
}

function sendRaw(target: CaptureGate, request: string): Promise<Answer> {
  const socket = net.connect({ host: '127.0.0.1', port: target.port });
  socket.write(request);
  return readAnswer(socket);
}

const connect = (target: CaptureGate, authority: string): Promise<Answer> => sendRaw(target, `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
const getVia = (target: CaptureGate, url: string): Promise<Answer> => sendRaw(target, `GET ${url} HTTP/1.1\r\nHost: ignored.example\r\nConnection: close\r\n\r\n`);

async function upstream(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  upstreamServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as net.AddressInfo).port;
}

beforeEach(() => {
  dialed.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await gate?.close();
  gate = undefined;
  await Promise.all(upstreamServers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

describe('an address or a name that is not public is refused in both request forms, and nothing is dialled', () => {
  it.each([...BLOCKED_ADDRESSES, ...BLOCKED_HOSTS])('%s (%s): CONNECT on 443 and 80 and a plain GET', async (_what, host) => {
    // A name server that would send every name to a public address, so only the guard on the name and the literal stops these.
    const asked = nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const target = await openGate();
    for (const port of [HTTPS_PORT, HTTP_PORT]) {
      const answer = await connect(target, `${host}:${port}`);
      expect(answer.status, `CONNECT ${host}:${port}`).toMatch(/^HTTP\/1\.1 403 /);
      expect(answer.headers['x-capture-gate']).toBe('blocked');
    }
    const plain = await getVia(target, `http://${host}/admin`);
    // A zone id is not part of a URL, so a browser cannot send it and the request is refused as malformed.
    expect(plain.status, `GET http://${host}/admin`).toMatch(/^HTTP\/1\.1 (403|400) /);
    expect(dialed).toEqual([]);
    expect(target.passed).toEqual([]);
    expect(target.refusals.map((refusal) => refusal.reason).slice(0, 2)).toEqual(['blocked', 'blocked']);
    expect(['blocked', 'malformed']).toContain(target.refusals[2].reason);
    // A name that is internal on its face is refused without asking the name server at all.
    if (/[a-z]/i.test(host) && host.includes('.') === false) expect(asked).toEqual([]);
  });

  it.each(BLOCKED_PORTS)('port %i is refused for a public host without resolving it', async (port) => {
    const asked = nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const target = await openGate();
    const answer = await connect(target, `allowed.example:${port}`);
    expect(answer.status).toMatch(/^HTTP\/1\.1 403 /);
    expect(answer.headers['x-capture-gate']).toBe('port');
    expect(asked).toEqual([]);
    expect(dialed).toEqual([]);
  });
});

describe('a name whose answers are not all public is refused, whatever the first answer is', () => {
  it.each([
    ['a private address', [{ address: '10.1.2.3', family: 4 }]],
    ['loopback', [{ address: '127.0.0.1', family: 4 }]],
    ['the metadata address', [{ address: '169.254.169.254', family: 4 }]],
    ['an IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }]],
    ['an IPv6 loopback', [{ address: '::1', family: 6 }]],
    ['a public address first and a private one second', [{ address: PUBLIC_V4, family: 4 }, { address: '192.168.0.10', family: 4 }]],
    ['a private address first and a public one second', [{ address: '192.168.0.10', family: 4 }, { address: PUBLIC_V4, family: 4 }]],
    ['a public IPv6 address and a link-local one', [{ address: PUBLIC_V6, family: 6 }, { address: 'fe80::1', family: 6 }]],
    ['a NAT64 address that carries a private one', [{ address: '64:ff9b::a00:1', family: 6 }]],
  ] as Array<[string, LookupAddress[]]>)('%s', async (_what, addresses) => {
    nameServer(addresses);
    const target = await openGate();
    expect((await connect(target, `rebind.example:${HTTPS_PORT}`)).headers['x-capture-gate']).toBe('blocked');
    expect((await getVia(target, 'http://rebind.example/')).headers['x-capture-gate']).toBe('blocked');
    expect(dialed).toEqual([]);
  });

  it('a name with no address is refused as unresolved', async () => {
    nameServer([]);
    const target = await openGate();
    expect((await connect(target, `nowhere.example:${HTTPS_PORT}`)).headers['x-capture-gate']).toBe('unresolved');
    expect(dialed).toEqual([]);
  });
});

describe('DNS rebinding: the answer that was checked is the address that is dialled', () => {
  it('asks the name server once for a connection and dials the address it checked, by address', async () => {
    // The first answer is public and the second would be loopback: the gate must not ask again between the check and the connect.
    const asked = nameServer((_name, call) => [{ address: call === 1 ? PUBLIC_V4 : '127.0.0.1', family: 4 }]);
    const port = await upstream((_request, response) => response.end('ok'));
    const target = await openGate({}, port);
    const answer = await getVia(target, 'http://rebind.example/page');
    expect(answer.status).toMatch(/^HTTP\/1\.1 200 /);
    expect(asked).toEqual(['rebind.example']);
    expect(dialed).toEqual([{ address: PUBLIC_V4, family: 4, port: HTTP_PORT }]);
  });

  it('checks each new connection afresh: the name that turned private is refused the next time', async () => {
    const asked = nameServer((_name, call) => [{ address: call === 1 ? PUBLIC_V4 : '10.0.0.5', family: 4 }]);
    const port = await upstream((_request, response) => response.end('ok'));
    const target = await openGate({}, port);
    expect((await getVia(target, 'http://rebind.example/')).status).toMatch(/^HTTP\/1\.1 200 /);
    const second = await getVia(target, 'http://rebind.example/');
    expect(second.status).toMatch(/^HTTP\/1\.1 403 /);
    expect(asked).toHaveLength(2);
    expect(dialed).toHaveLength(1);
  });

  it('dials an IP literal and never the name, so the dial cannot resolve it again', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const port = await upstream((_request, response) => response.end('ok'));
    const target = await openGate({}, port);
    await getVia(target, 'http://rebind.example:80/');
    for (const dial of dialed) expect(net.isIP(dial.address)).not.toBe(0);
  });

  it('refuses a connection that lands on an address other than the checked one, after it is made', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const realConnect = net.connect.bind(net) as (...args: unknown[]) => net.Socket;
    // The real dial is used. Whatever carries the connection (a route that is rewritten, a library that resolves again) delivers it to
    // the local echo here, so the peer of the socket is not the address the guard returned: the post-connect check must end it.
    vi.spyOn(net, 'connect').mockImplementation(((options: { host?: string }, ...rest: unknown[]) =>
      realConnect(options.host === PUBLIC_V4 ? { host: '127.0.0.1', port: (echo.address() as net.AddressInfo).port } : options, ...rest)) as never);
    try {
      gate = await startCaptureGate();
      const answer = await connect(gate, `peer.example:${HTTPS_PORT}`);
      expect(answer.status).toMatch(/^HTTP\/1\.1 502 /);
      expect(gate.refusals).toEqual([{ host: 'peer.example', port: HTTPS_PORT, reason: 'peer' }]);
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });
});

describe('redirects are never followed by the gate: each hop is a new request that is checked', () => {
  it('passes a redirect to a private address back to the browser and refuses the request the browser then makes', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    let requests = 0;
    const port = await upstream((_request, response) => {
      requests += 1;
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    });
    const target = await openGate({}, port);
    const first = await getVia(target, 'http://redirect.example/start');
    expect(first.status).toMatch(/^HTTP\/1\.1 302 /);
    expect(first.headers.location).toBe('http://169.254.169.254/latest/meta-data/');
    expect(requests).toBe(1);
    const second = await getVia(target, first.headers.location);
    expect(second.status).toMatch(/^HTTP\/1\.1 403 /);
    expect(requests).toBe(1);
    expect(dialed).toHaveLength(1);
  });

  it('refuses the redirect to a name that resolves into a private range, and to a numeric loopback, at the same gate', async () => {
    nameServer((name) => [{ address: name === 'inner.example' ? '10.9.9.9' : PUBLIC_V4, family: 4 }]);
    const target = await openGate();
    expect((await connect(target, `inner.example:${HTTPS_PORT}`)).status).toMatch(/^HTTP\/1\.1 403 /);
    expect((await connect(target, `2130706433:${HTTPS_PORT}`)).status).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed).toEqual([]);
  });
});

describe('what the gate serves', () => {
  it('relays a CONNECT tunnel to a public host byte for byte, for the address the guard returned', async () => {
    nameServer([{ address: PUBLIC_V6, family: 6 }]);
    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    try {
      const target = await openGate({}, (echo.address() as net.AddressInfo).port);
      const socket = net.connect({ host: '127.0.0.1', port: target.port });
      socket.write(`CONNECT tunnel.example:${HTTPS_PORT} HTTP/1.1\r\nHost: tunnel.example:${HTTPS_PORT}\r\n\r\n`);
      const echoed = await new Promise<string>((resolve) => {
        let text = '';
        socket.on('data', (chunk: Buffer) => {
          text += chunk.toString('latin1');
          if (text.includes('\r\n\r\n') && !text.endsWith('\r\n\r\n')) resolve(text.split('\r\n\r\n')[1]);
          else if (text.endsWith('\r\n\r\n')) socket.write('hello through the gate');
        });
      });
      socket.destroy();
      expect(echoed).toBe('hello through the gate');
      expect(dialed).toEqual([{ address: PUBLIC_V6, family: 6, port: HTTPS_PORT }]);
      expect(target.bytes()).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
  });

  it('forwards a plain request to the vetted address with the Host of the URL and without proxy headers, and gives the answer back', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    let seen: http.IncomingHttpHeaders = {};
    let seenUrl = '';
    const port = await upstream((request, response) => {
      seen = request.headers;
      seenUrl = request.url ?? '';
      response.writeHead(200, { 'content-type': 'text/plain', 'x-answer': 'yes' });
      response.end('body');
    });
    const target = await openGate({}, port);
    const answer = await sendRaw(target, 'GET http://site.example/a/b?c=1 HTTP/1.1\r\nHost: ignored.example\r\nProxy-Authorization: Basic eDp5\r\nProxy-Connection: keep-alive\r\nX-Page: 1\r\nConnection: close\r\n\r\n');
    expect(answer.status).toMatch(/^HTTP\/1\.1 200 /);
    expect(answer.headers['x-answer']).toBe('yes');
    expect(seenUrl).toBe('/a/b?c=1');
    expect(seen.host).toBe('site.example');
    expect(seen['x-page']).toBe('1');
    expect(seen['proxy-authorization']).toBeUndefined();
    expect(seen['proxy-connection']).toBeUndefined();
  });

  it('refuses request forms a proxy has no use for', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const target = await openGate();
    const cases: Array<[string, string]> = [
      ['an origin-form request', 'GET /internal HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'],
      ['an https URL on the plain route', 'GET https://site.example/ HTTP/1.1\r\nHost: site.example\r\n\r\n'],
      ['a file URL', 'GET file:///etc/passwd HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['an ftp URL', 'GET ftp://site.example/ HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['credentials in the URL', 'GET http://user:pass@site.example/ HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['credentials that hide a loopback host', 'GET http://site.example@127.0.0.1/ HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['a CONNECT without a port', 'CONNECT site.example HTTP/1.1\r\nHost: site.example\r\n\r\n'],
      ['a CONNECT with a path', 'CONNECT /site.example:443 HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['a CONNECT with user information', 'CONNECT user@site.example:443 HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['a CONNECT with an unclosed bracket', 'CONNECT [::1:443 HTTP/1.1\r\nHost: x\r\n\r\n'],
      ['a CONNECT that hides a loopback address behind a public one', 'CONNECT site.example:443@127.0.0.1:80 HTTP/1.1\r\nHost: x\r\n\r\n'],
    ];
    for (const [what, request] of cases) {
      const answer = await sendRaw(target, request);
      expect(answer.status, what).toMatch(/^HTTP\/1\.1 (400|403) /);
    }
    const upgrade = await sendRaw(target, 'GET http://site.example/socket HTTP/1.1\r\nHost: site.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    expect(upgrade.status).toMatch(/^HTTP\/1\.1 403 /);
    expect(dialed).toEqual([]);
  });
});

describe('the limits of one capture', () => {
  it('refuses a connection past the cap on open connections', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const hold = net.createServer((socket) => socket.on('error', () => undefined));
    await new Promise<void>((resolve) => hold.listen(0, '127.0.0.1', resolve));
    const held: net.Socket[] = [];
    try {
      const target = await openGate({ maxConnections: 2 }, (hold.address() as net.AddressInfo).port);
      for (let index = 0; index < 2; index++) {
        const socket = net.connect({ host: '127.0.0.1', port: target.port });
        socket.on('error', () => undefined);
        socket.write(`CONNECT hold${index}.example:${HTTPS_PORT} HTTP/1.1\r\nHost: x\r\n\r\n`);
        held.push(socket);
      }
      await vi.waitFor(() => expect(dialed).toHaveLength(2));
      const refused = await connect(target, `third.example:${HTTPS_PORT}`);
      expect(refused.status).toMatch(/^HTTP\/1\.1 403 /);
      expect(refused.headers['x-capture-gate']).toBe('limit');
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => hold.close(() => resolve()));
    }
  });

  it('ends the relay when more bytes pass than the cap, and says so', async () => {
    nameServer([{ address: PUBLIC_V4, family: 4 }]);
    const sockets: net.Socket[] = [];
    const flood = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.write(Buffer.alloc(64 * 1024));
    });
    await new Promise<void>((resolve) => flood.listen(0, '127.0.0.1', resolve));
    try {
      const target = await openGate({ maxBytes: 16 * 1024 }, (flood.address() as net.AddressInfo).port);
      const socket = net.connect({ host: '127.0.0.1', port: target.port });
      socket.on('error', () => undefined);
      socket.resume();
      socket.write(`CONNECT flood.example:${HTTPS_PORT} HTTP/1.1\r\nHost: x\r\n\r\n`);
      await new Promise<void>((resolve) => socket.on('close', () => resolve()));
      expect(target.refusals.some((refusal) => refusal.reason === 'limit')).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => flood.close(() => resolve()));
    }
  });

  it('listens on the loopback interface only, and stops serving when closed', async () => {
    const target = await openGate();
    const probe = await new Promise<net.Socket>((resolve) => { const socket = net.connect({ host: '127.0.0.1', port: target.port }, () => resolve(socket)); socket.on('error', () => undefined); });
    const server = probe.remoteAddress;
    probe.destroy();
    expect(server).toBe('127.0.0.1');
    await target.close();
    await expect(new Promise((resolve, reject) => { const socket = net.connect({ host: '127.0.0.1', port: target.port }); socket.once('connect', resolve); socket.once('error', reject); })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    gate = undefined;
  });
});

describe('the guard behind the gate is the project guard', () => {
  it('uses ssrfSafeLookup when no lookup is given', async () => {
    const asked = nameServer([{ address: '10.20.30.40', family: 4 }]);
    gate = await startCaptureGate({ dial: (target) => { dialed.push(target); return net.connect({ host: '127.0.0.1', port: 9 }); } });
    expect((await connect(gate, `internal-name.example:${HTTPS_PORT}`)).headers['x-capture-gate']).toBe('blocked');
    // The refusal came from the answer of the name server, through the project's lookup, which asked it for all addresses.
    expect(asked).toEqual(['internal-name.example']);
  });
});
