import { describe, it, expect, afterEach, vi } from 'vitest';
import dns, { type LookupAddress, type LookupOptions } from 'node:dns';
import net from 'node:net';
import { ssrfSafeLookup } from '../src/lib/security/ssrf';

/**
 * The connect-time lookup must speak both shapes of the Node lookup contract: a single
 * (address, family) pair, and the `{ all: true }` array that Happy Eyeballs
 * (autoSelectFamily, on by default since Node 20) requests. Restricted IPs are refused either way.
 */

const PUBLIC_V4 = '93.184.215.14';
const PUBLIC_V6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
const PUBLIC_ADDRESSES: LookupAddress[] = [
  { address: PUBLIC_V4, family: 4 },
  { address: PUBLIC_V6, family: 6 },
];
const HTTP_PORT = 80;

type LookupResult = { err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number };

function mockResolver(addresses: LookupAddress[]) {
  return vi.spyOn(dns, 'lookup').mockImplementation(((
    _host: string,
    _opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void
  ) => {
    process.nextTick(() => cb(null, addresses));
  }) as never);
}

function lookup(hostname: string, options: LookupOptions): Promise<LookupResult> {
  return new Promise((resolve) => {
    ssrfSafeLookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ssrfSafeLookup', () => {
  it('returns every validated address when called with { all: true }', async () => {
    mockResolver(PUBLIC_ADDRESSES);
    const result = await lookup('pinned.example', { all: true });
    expect(result.err).toBeNull();
    expect(result.address).toEqual([
      { address: PUBLIC_V4, family: 4 },
      { address: PUBLIC_V6, family: 6 },
    ]);
  });

  it('returns a single address and family without { all: true }', async () => {
    mockResolver(PUBLIC_ADDRESSES);
    const result = await lookup('pinned.example', {});
    expect(result.err).toBeNull();
    expect(result.address).toBe(PUBLIC_V4);
    expect(result.family).toBe(4);
  });

  it('honours a requested address family', async () => {
    mockResolver(PUBLIC_ADDRESSES);
    const single = await lookup('pinned.example', { family: 6 });
    expect(single.err).toBeNull();
    expect(single.address).toBe(PUBLIC_V6);
    expect(single.family).toBe(6);

    const all = await lookup('pinned.example', { family: 6, all: true });
    expect(all.address).toEqual([{ address: PUBLIC_V6, family: 6 }]);
  });

  it('refuses a literal loopback host without resolving it', async () => {
    const resolver = mockResolver(PUBLIC_ADDRESSES);
    const result = await lookup('127.0.0.1', { all: true });
    expect(result.err?.message).toMatch(/SSRF blocked: host 127\.0\.0\.1 is restricted/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses a hostname when any resolved address is private', async () => {
    mockResolver([{ address: PUBLIC_V4, family: 4 }, { address: '10.0.0.7', family: 4 }]);
    const result = await lookup('rebind.example', { all: true });
    expect(result.err?.message).toMatch(/SSRF blocked: resolved IP 10\.0\.0\.7 is restricted/);
  });

  it('refuses a hostname that resolves to no address', async () => {
    mockResolver([]);
    const result = await lookup('empty.example', {});
    expect(result.err?.message).toMatch(/could not resolve host empty\.example/);
  });

  it('lets net.connect with autoSelectFamily attempt the validated address', async () => {
    mockResolver(PUBLIC_ADDRESSES);
    expect(typeof ssrfSafeLookup).toBe('function');
    const lookupSpy = vi.fn(ssrfSafeLookup);
    const attempt = await new Promise<{ ip: string; port: number; family: number }>((resolve, reject) => {
      const socket = net.connect({ host: 'pinned.example', port: HTTP_PORT, lookup: lookupSpy, autoSelectFamily: true });
      socket.once('connectionAttempt', (ip: string, port: number, family: number) => {
        // Destroy after the attempt has started; destroying inside the event races Node's connect call.
        setImmediate(() => socket.destroy());
        resolve({ ip, port, family });
      });
      socket.once('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
    expect(lookupSpy).toHaveBeenCalledWith('pinned.example', expect.objectContaining({ all: true }), expect.any(Function));
    expect(attempt).toEqual({ ip: PUBLIC_V4, port: HTTP_PORT, family: 4 });
  });
});
