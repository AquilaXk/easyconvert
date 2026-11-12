import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertCaptureUrl, captureWebsite } from '../src/lib/capture/website-capture';
import { CaptureFailedError, CaptureTargetBlockedError, CaptureUnavailableError } from '../src/lib/capture/website-capture-errors';
import { CpuTaskTimeoutError, EngineUnavailableError } from '../src/lib/types';
import { refusalCodeOf } from '../src/lib/refusal-codes';
import { runWithoutFileConfinement } from './helpers/unconfined-files';
import { skipUnless } from './helpers/strict-skip';

/**
 * The capture around the browser, with a Python stand-in for the driver (the real one needs Qt WebEngine, which the worker image
 * carries and CI does not). The stand-in reads the request the way the driver does, asks for what a page would ask for through the
 * proxy it is given, and answers with the report line the driver prints, so what is under test is the route: the refusal of the first
 * address, the gate between the browser and the network, the report, the file check and the typed errors.
 */

runWithoutFileConfinement();

const PUBLIC = [{ address: '93.184.216.34', family: 4 }] as LookupAddress[];
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((candidate) => existsSync(candidate));
const PNG_BYTES = 'b"\\x89PNG\\r\\n\\x1a\\n" + b"stand-in picture"';

/** The stand-in driver: behaviour is chosen by the path of the URL, as a page would choose it. */
const STAND_IN = `
import json, socket, sys
request = json.load(open(sys.argv[1]))
def say(report):
    sys.stdout.write(json.dumps(report) + '\\n'); sys.stdout.flush()
def through_proxy(authority):
    """What the browser does for a request of the page: a CONNECT to the gate; returns the status line."""
    s = socket.create_connection(('127.0.0.1', request['proxyPort']), timeout=5)
    s.sendall(('CONNECT %s HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n' % (authority, authority)).encode())
    line = s.recv(200).split(b'\\r\\n')[0].decode()
    s.close()
    return line
path = request['url'].split('/', 3)[3] if request['url'].count('/') >= 3 else ''
out = sys.argv[1].rsplit('/', 1)[0] + '/' + request['output']
if path.startswith('crash'):
    sys.exit(3)
if path.startswith('timeout'):
    say({'ok': False, 'code': 'timeout', 'detail': 'slow'}); sys.exit(0)
if path.startswith('redirect-private'):
    status = through_proxy('169.254.169.254:80')
    say({'ok': False, 'code': 'load_failed', 'detail': status}); sys.exit(0)
if path.startswith('subresource-private'):
    status = through_proxy('10.0.0.5:443')
    status2 = through_proxy('localhost:80')
    open(out, 'wb').write(${PNG_BYTES} if request['format'] == 'png' else b'%PDF-1.7 stand-in')
    say({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': status + ' / ' + status2, 'blocked': ['file:///etc/passwd']}); sys.exit(0)
if path.startswith('badfile'):
    open(out, 'wb').write(b'<html>not a pdf</html>')
    say({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': ''}); sys.exit(0)
if path.startswith('echo'):
    open(out, 'wb').write(${PNG_BYTES} if request['format'] == 'png' else b'%PDF-1.7 ' + json.dumps(request).encode())
    say({'ok': True, 'output': request['output'], 'finalUrl': 'https://example.org/final', 'title': 'Echo'}); sys.exit(0)
open(out, 'wb').write(b'%PDF-1.7 stand-in' if request['format'] == 'pdf' else (b'\\xff\\xd8\\xff stand-in' if request['format'] == 'jpg' else ${PNG_BYTES}))
say({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': 'Stand-in page', 'blocked': []})
`;

let dir = '';
let driver = '';

beforeAll(() => {
  skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined);
  dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-capture-'));
  driver = path.join(dir, 'capture.py');
  writeFileSync(driver, STAND_IN);
  chmodSync(driver, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Every name is public, as the stand-in's page host is; literals are resolved by the real function. */
function publicNames(): void {
  const realLookup = dns.lookup;
  vi.spyOn(dns, 'lookup').mockImplementation(((name: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, list: LookupAddress[]) => void) => {
    if (net.isIP(name) !== 0) return (realLookup as (...args: unknown[]) => void)(name, options, callback);
    process.nextTick(() => callback(null, PUBLIC));
  }) as never);
  // The check of the first address resolves through the promise API.
  vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => PUBLIC) as never);
}

function useStandIn(): void {
  publicNames();
  vi.stubEnv('CAPTURE_WEBSITE_ENABLED', 'true');
  vi.stubEnv('CAPTURE_PYTHON_PATH', PYTHON as string);
  vi.stubEnv('CAPTURE_DRIVER_PATH', driver);
}

describe.skipIf(skipUnless('a Python 3 interpreter for the stand-in driver', PYTHON !== undefined))('website capture', () => {
  it.each([
    ['pdf', 'application/pdf', /^%PDF-/],
    ['png', 'image/png', /^\x89PNG/],
    ['jpg', 'image/jpeg', /^\xff\xd8\xff/],
  ])('captures a page as %s and names the file after the page', async (format, mimeType, magic) => {
    useStandIn();
    const result = await captureWebsite({ url: 'https://news.example/articles/today?id=1', format });
    expect(result.mimeType).toBe(mimeType);
    expect(result.buffer.toString('latin1')).toMatch(magic);
    expect(result.filename).toBe(`news.example-articles-today.${format}`);
    expect(result).toMatchObject({ finalUrl: 'https://news.example/articles/today?id=1', title: 'Stand-in page', warnings: [] });
  });

  it('hands the driver the options of the request and the loopback port of the gate, and the URL it was checked for', async () => {
    useStandIn();
    const result = await captureWebsite({
      url: 'https://site.example/echo',
      format: 'pdf',
      options: { fullPage: true, viewport: { width: 900, height: 500 }, waitUntil: 'idle', delayMs: 250, pdf: { paper: 'Letter', landscape: true, margin: 12 } },
      timeoutMs: 15_000,
    });
    const sent = JSON.parse(result.buffer.toString('latin1').slice('%PDF-1.7 '.length));
    expect(sent).toMatchObject({
      url: 'https://site.example/echo',
      format: 'pdf',
      fullPage: true,
      viewport: { width: 900, height: 500 },
      waitUntil: 'idle',
      delayMs: 250,
      timeoutMs: 15_000,
      output: 'capture.pdf',
      pdf: { paper: 'Letter', landscape: true, margin: 12 },
    });
    expect(sent.proxyPort).toBeGreaterThan(0);
    expect(result.finalUrl).toBe('https://example.org/final');
  });

  it('gives the browser a gate that refuses what the page asks for beyond the public web, and says what was left out', async () => {
    useStandIn();
    const result = await captureWebsite({ url: 'https://site.example/subresource-private', format: 'png' });
    expect(result.title).toBe('HTTP/1.1 403 Refused / HTTP/1.1 403 Refused');
    expect(result.warnings).toEqual([
      '2 request(s) of the page to addresses that are not public were refused and left out.',
      '1 request(s) of the page for a resource that is not on the web (file, ftp, ...) were refused.',
    ]);
  });

  it('answers a navigation that was refused at a hop as blocked, not as a failed load', async () => {
    useStandIn();
    const run = captureWebsite({ url: 'https://site.example/redirect-private', format: 'png' });
    await expect(run).rejects.toBeInstanceOf(CaptureTargetBlockedError);
    await expect(run).rejects.toThrow(/169\.254\.169\.254:80.*not a public web address/);
  });

  it('answers the browser that stops, the file that is not the format, and the timeout of the driver with their own errors', async () => {
    useStandIn();
    const crash = captureWebsite({ url: 'https://site.example/crash', format: 'png' });
    await expect(crash).rejects.toBeInstanceOf(CaptureFailedError);
    await expect(crash).rejects.toThrow(/stopped before it drew the page/);
    const bad = captureWebsite({ url: 'https://site.example/badfile', format: 'pdf' });
    await expect(bad).rejects.toBeInstanceOf(CaptureFailedError);
    await expect(bad).rejects.toThrow(/not a PDF/);
    const slow = captureWebsite({ url: 'https://site.example/timeout', format: 'png', timeoutMs: 2000 });
    await expect(slow).rejects.toBeInstanceOf(CpuTaskTimeoutError);
    await expect(slow).rejects.toThrow(/2000 ms/);
  });

  it('is unavailable on a worker without the driver or the interpreter', async () => {
    publicNames();
    vi.stubEnv('CAPTURE_WEBSITE_ENABLED', 'true');
    vi.stubEnv('CAPTURE_PYTHON_PATH', PYTHON as string);
    vi.stubEnv('CAPTURE_DRIVER_PATH', path.join(dir, 'missing.py'));
    const run = captureWebsite({ url: 'https://site.example/', format: 'png' });
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toThrow(/driver or its Python interpreter/);
    vi.stubEnv('CAPTURE_DRIVER_PATH', driver);
    vi.stubEnv('CAPTURE_PYTHON_PATH', path.join(dir, 'no-python'));
    await expect(captureWebsite({ url: 'https://site.example/', format: 'png' })).rejects.toBeInstanceOf(EngineUnavailableError);
  });

  it('is refused by a worker that has capture off, before the address is looked at and before anything starts', async () => {
    publicNames();
    vi.stubEnv('CAPTURE_PYTHON_PATH', PYTHON as string);
    vi.stubEnv('CAPTURE_DRIVER_PATH', driver);
    for (const value of [undefined, '', 'false', '0', 'yes']) {
      if (value === undefined) vi.stubEnv('CAPTURE_WEBSITE_ENABLED', undefined as unknown as string);
      else vi.stubEnv('CAPTURE_WEBSITE_ENABLED', value);
      const run = captureWebsite({ url: 'https://site.example/echo', format: 'pdf' });
      await expect(run).rejects.toBeInstanceOf(CaptureUnavailableError);
      await expect(run).rejects.toThrow('Website capture is not enabled on this server.');
      expect(refusalCodeOf(await run.catch((caught: unknown) => caught))).toBe('capture_unavailable');
    }
  });

  it('refuses a format a page is not captured as', async () => {
    useStandIn();
    await expect(captureWebsite({ url: 'https://site.example/', format: 'gif' })).rejects.toThrow(/pdf, png or jpg, not "gif"/);
  });
});

describe('the address of a capture is checked before a browser is started', () => {
  const blocked: Array<[string, string]> = [
    ['not a URL', 'not a url'],
    ['a file URL', 'file:///etc/passwd'],
    ['an ftp URL', 'ftp://files.example/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<h1>x</h1>'],
    ['credentials in the URL', 'https://user:secret@site.example/'],
    ['a port outside 80 and 443', 'https://site.example:8443/'],
    ['port 22', 'http://site.example:22/'],
    ['loopback', 'http://127.0.0.1/'],
    ['localhost', 'http://localhost/admin'],
    ['the metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['an IPv6 loopback', 'http://[::1]/'],
    ['a decimal loopback', 'http://2130706433/'],
    ['an internal name', 'http://db.internal/'],
  ];

  it.each(blocked)('refuses %s with the coded 422 and starts nothing', async (_what, url) => {
    publicNames();
    const run = assertCaptureUrl(url);
    await expect(run).rejects.toBeInstanceOf(CaptureTargetBlockedError);
    const error = await run.catch((caught: unknown) => caught);
    expect(refusalCodeOf(error)).toBe('capture_target_blocked');
    expect((error as { status: number }).status).toBe(422);
  });

  it('refuses a name that resolves into a private range', async () => {
    vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => [{ address: '10.1.2.3', family: 4 }]) as never);
    await expect(assertCaptureUrl('https://looks-public.example/')).rejects.toThrow(/not a public one/);
  });

  it('accepts a public web address on the web ports', async () => {
    publicNames();
    expect((await assertCaptureUrl('https://site.example/a?b=1')).href).toBe('https://site.example/a?b=1');
    expect((await assertCaptureUrl('http://site.example:80/')).port).toBe('');
    expect((await assertCaptureUrl('https://site.example:443/')).hostname).toBe('site.example');
  });

  it('does not reach the driver for a refused address', async () => {
    useStandIn();
    const asked = vi.fn();
    await expect(captureWebsite({ url: 'http://127.0.0.1/', format: 'png', gate: { dial: asked } })).rejects.toBeInstanceOf(CaptureTargetBlockedError);
    expect(asked).not.toHaveBeenCalled();
  });
});
