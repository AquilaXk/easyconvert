import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertCaptureUrl, captureWebsite } from '../src/lib/capture/website-capture';
import { CaptureFailedError, CaptureTargetBlockedError, CaptureUnavailableError } from '../src/lib/capture/website-capture-errors';
import * as processSandbox from '../src/lib/security/process-sandbox';
import { CpuTaskTimeoutError, EngineUnavailableError, SandboxUnavailableError } from '../src/lib/types';
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
    """What the browser does for a request of the page: a CONNECT to the gate over AF_UNIX; returns the status line."""
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(request['proxySocket'])
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
if path.startswith('fallback'):
    status = through_proxy('dual.example:443')
    open(out, 'wb').write(${PNG_BYTES} if request['format'] == 'png' else b'%PDF-1.7 stand-in')
    say({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': status, 'blocked': []}); sys.exit(0)
if path.startswith('symlink'):
    import os
    secret = sys.argv[1].rsplit('/', 1)[0] + '/../secret-of-the-worker.txt'
    open(secret, 'w').write('%PDF-1.7 a file of the worker, not a capture')
    os.symlink(secret, out)
    say({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': '', 'blocked': []}); sys.exit(0)
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

  it('hands the driver the options of the request and the AF_UNIX gate socket, omits proxyPort, and stays network-isolated', async () => {
    useStandIn();
    const execSpy = vi.spyOn(processSandbox, 'executeSandboxedBinary');
    const beforeGateDirs = new Set(readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('easyconvert-gate-')));
    const result = await captureWebsite({
      url: 'https://site.example/echo',
      format: 'pdf',
      options: { fullPage: true, viewport: { width: 900, height: 500 }, waitUntil: 'idle', delayMs: 250, pdf: { paper: 'Letter', landscape: true, margin: 12 }, proxyPort: 9999 } as never,
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
    expect(sent.proxyPort).toBeUndefined();
    expect(sent.proxySocket).toMatch(/easyconvert-gate-[^/\\]+\/g\.sock$/);
    expect(existsSync(sent.proxySocket)).toBe(false);
    const afterGateDirs = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('easyconvert-gate-') && !beforeGateDirs.has(entry));
    expect(afterGateDirs).toEqual([]);
    expect(execSpy).toHaveBeenCalledTimes(1);
    const sandboxArg = execSpy.mock.calls[0]?.[2] as { networkIsolated?: boolean; sandboxOptions?: { keepNetwork?: boolean }; rlimits?: { asBytes?: number; coreBytes?: number } };
    expect(sandboxArg.networkIsolated).toBe(true);
    expect(sandboxArg.sandboxOptions?.keepNetwork).toBeUndefined();
    expect(sandboxArg.rlimits).toEqual({ asBytes: 2048 * 1024 * 1024 * 1024, coreBytes: 1 });
    expect(result.finalUrl).toBe('https://example.org/final');
  });

  it('cleans up the ephemeral gate directory and socket when the driver crashes or aborts mid-run', async () => {
    useStandIn();
    const beforeGateDirs = new Set(readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('easyconvert-gate-')));
    await expect(captureWebsite({ url: 'https://site.example/crash', format: 'png' })).rejects.toBeInstanceOf(CaptureFailedError);
    const afterGateDirs = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('easyconvert-gate-') && !beforeGateDirs.has(entry));
    expect(afterGateDirs).toEqual([]);

    const slowDriver = path.join(dir, 'capture-abort.py');
    writeFileSync(slowDriver, 'import time\ntime.sleep(30)\n');
    chmodSync(slowDriver, 0o755);
    vi.stubEnv('CAPTURE_DRIVER_PATH', slowDriver);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('client aborted')), 80);
    await expect(captureWebsite({ url: 'https://site.example/slow-abort', format: 'png', signal: controller.signal })).rejects.toThrow('client aborted');
    const afterAbortDirs = readdirSync(os.tmpdir()).filter((entry) => entry.startsWith('easyconvert-gate-') && !beforeGateDirs.has(entry));
    expect(afterAbortDirs).toEqual([]);
  });

  it('fails closed with SandboxUnavailableError when TMPDIR exceeds the AF_UNIX sun_path bound', async () => {
    useStandIn();
    const execSpy = vi.spyOn(processSandbox, 'executeSandboxedBinary');
    const deepRoot = mkdtempSync(path.join(os.tmpdir(), 'ecg-deep-'));
    const deepTmp = path.join(deepRoot, 'x'.repeat(90));
    try {
      const fsMod = await import('node:fs');
      fsMod.mkdirSync(deepTmp, { recursive: true });
      vi.stubEnv('TMPDIR', deepTmp);
      const run = captureWebsite({ url: 'https://site.example/deep', format: 'png' });
      await expect(run).rejects.toBeInstanceOf(SandboxUnavailableError);
      await expect(run).rejects.toThrow(/gate socket could not be created/i);
      const caught = await run.then(() => undefined, (error: unknown) => error as { name?: string; engineName?: string; reason?: string });
      expect(caught).toMatchObject({ name: 'SandboxUnavailableError', engineName: 'sandbox' });
      expect(caught?.reason).toMatch(/exceeds \d+ bytes/);
      expect(refusalCodeOf(caught)).toBe('engine_unavailable');
      expect(execSpy).not.toHaveBeenCalled();
      expect(readdirSync(deepTmp)).toEqual([]);
    } finally {
      rmSync(deepRoot, { recursive: true, force: true });
    }
  });

  const CAN_NETNS = process.platform === 'linux' && processSandbox.getUnshareCapability().available;

  it.skipIf(skipUnless('unprivileged Linux namespaces (unshare -r -n)', CAN_NETNS))(
    'blocks direct TCP connections to host loopback inside the isolated netns while reaching the gate over AF_UNIX',
    async () => {
      useStandIn();
      const hostListener = net.createServer((sock) => sock.end('HOST-INTERNAL'));
      await new Promise<void>((resolve) => hostListener.listen(0, '127.0.0.1', resolve));
      const hostPort = (hostListener.address() as net.AddressInfo).port;
      const netnsDriver = path.join(dir, 'capture-netns.py');
      writeFileSync(
        netnsDriver,
        `
import json, socket, sys
request = json.load(open(sys.argv[1]))
out = sys.argv[1].rsplit('/', 1)[0] + '/' + request['output']
direct = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
direct.settimeout(2)
try:
    direct.connect(('127.0.0.1', ${hostPort}))
    direct_status = 'connected'
except OSError as err:
    direct_status = 'blocked:' + str(err.errno)
finally:
    direct.close()
u = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
u.settimeout(5)
u.connect(request['proxySocket'])
u.sendall(b'CONNECT 169.254.169.254:80 HTTP/1.1\\r\\nHost: 169.254.169.254:80\\r\\n\\r\\n')
proxy_line = u.recv(200).split(b'\\r\\n')[0].decode()
u.close()
open(out, 'wb').write(${PNG_BYTES})
sys.stdout.write(json.dumps({'ok': True, 'output': request['output'], 'finalUrl': request['url'], 'title': direct_status + '|' + proxy_line, 'blocked': []}) + '\\n')
`
      );
      chmodSync(netnsDriver, 0o755);
      vi.stubEnv('CAPTURE_DRIVER_PATH', netnsDriver);
      try {
        const result = await captureWebsite({ url: 'https://site.example/netns-probe', format: 'png' });
        expect(result.title).toMatch(/^blocked:\d+\|HTTP\/1\.1 403 Refused$/);
      } finally {
        await new Promise<void>((resolve) => hostListener.close(() => resolve()));
      }
    }
  );

  it('gives the browser a gate that refuses what the page asks for beyond the public web, and says what was left out', async () => {
    useStandIn();
    const result = await captureWebsite({ url: 'https://site.example/subresource-private', format: 'png' });
    expect(result.title).toBe('HTTP/1.1 403 Refused / HTTP/1.1 403 Refused');
    expect(result.warnings).toEqual([
      '2 request(s) of the page to addresses that are not public were refused and left out.',
      '1 request(s) of the page for a resource that is not on the web (file, ftp, ...) were refused.',
    ]);
  });

  it('falls back across validated public addresses when the first address refuses the connection', async () => {
    useStandIn();
    const deadServer = net.createServer();
    await new Promise<void>((resolve) => deadServer.listen(0, '127.0.0.1', resolve));
    const deadPort = (deadServer.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => deadServer.close(() => resolve()));

    const echo = net.createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
    const echoPort = (echo.address() as net.AddressInfo).port;

    const dialedTargets: Array<{ address: string; family: number; port: number }> = [];
    const dualAddrs: LookupAddress[] = [
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ];
    try {
      const result = await captureWebsite({
        url: 'https://dual.example/fallback',
        format: 'png',
        gate: {
          lookup: (_name, _opts, cb) => process.nextTick(() => (cb as (e: null, a: LookupAddress[]) => void)(null, dualAddrs)),
          dial: (target) => {
            dialedTargets.push(target);
            return net.connect({ host: '127.0.0.1', port: target.family === 4 ? echoPort : deadPort });
          },
        },
      });
      expect(result.title).toBe('HTTP/1.1 200 Connection Established');
      expect(result.warnings).toEqual([]);
      expect(dialedTargets).toEqual([
        { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6, port: 443 },
        { address: '93.184.216.34', family: 4, port: 443 },
      ]);
    } finally {
      await new Promise<void>((resolve) => echo.close(() => resolve()));
    }
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

  it('does not read the file of the worker that a page-driven browser left as a link in place of its output', async () => {
    useStandIn();
    const run = captureWebsite({ url: 'https://site.example/symlink', format: 'pdf' });
    await expect(run).rejects.toBeInstanceOf(CaptureFailedError);
    await expect(run).rejects.toThrow('The browser wrote no file.');
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
