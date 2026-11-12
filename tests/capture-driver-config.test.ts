import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * The browser driver needs Qt WebEngine, which CI does not have (the worker image carries it, and the image build draws a page with
 * it). What CI can hold the driver to is the shape of the browser it starts: the one route to the network, and the limits the page
 * runs under. A change that drops one of these takes the gate out of the path of the page, so each is pinned here by its text.
 */

const DRIVER = path.resolve(__dirname, '..', 'native', 'capture-website', 'capture.py');
const source = readFileSync(DRIVER, 'utf8');
const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3', '/opt/homebrew/bin/python3'].find((candidate) => existsSync(candidate));

/** Every command-line switch of the browser the driver names, in the order it names them. */
const switches = [...source.matchAll(/'(--[^']*)'/g)].map((match) => match[1]);
const numberOf = (name: string): string | undefined => new RegExp(`${name} = (\\d+)`).exec(source)?.[1];

describe('the capture driver', () => {
  it('sends every request to the gate: the proxy is the only route, loopback and link-local addresses are not exempt, and no name is resolved by the browser', () => {
    expect(switches.filter((flag) => /^--(proxy|host-resolver)/.test(flag))).toEqual([
      '--proxy-server=http://127.0.0.1:%d',
      '--proxy-bypass-list=<-loopback>',
      '--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE 127.0.0.1"',
    ]);
  });

  it('keeps WebRTC off a direct route and DNS prefetch off, and starts no background network traffic', () => {
    expect(switches.filter((flag) => /webrtc|dns-prefetch|background-networking|component-update|sync/.test(flag))).toEqual([
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--dns-prefetch-disable',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--force-webrtc-ip-handling-policy',
    ]);
  });

  it('loads only web pages and data URLs: no file, ftp or other scheme is allowed, and the browser refuses the rest itself', () => {
    expect(source).toContain("ALLOWED_SCHEMES = ('http', 'https', 'data', 'about', 'blob')");
    expect(source).toContain('info.block(True)');
    expect(source).not.toMatch(/ALLOWED_SCHEMES[^\n]*'(file|ftp|ws|wss|chrome|view-source|filesystem)'/);
  });

  it('runs the page without windows, downloads, plug-ins, file access, device permissions or stored state', () => {
    for (const setting of ["('JavascriptCanOpenWindows', False)", "('PluginsEnabled', False)", "('LocalContentCanAccessFileUrls', False)", "('LocalContentCanAccessRemoteUrls', False)", "('ScreenCaptureEnabled', False)", "('JavascriptCanAccessClipboard', False)", "('WebRTCPublicInterfacesOnly', True)"]) {
      expect(source).toContain(setting);
    }
    expect(source).toContain('profile.downloadRequested.connect(lambda item: item.cancel())');
    expect(source).toContain('PermissionDeniedByUser');
    expect(source).toContain('NoPersistentCookies');
  });

  it('keeps the size of a picture and the wait of a page within fixed bounds', () => {
    expect([numberOf('MAX_FULL_PAGE_HEIGHT'), numberOf('MAX_DELAY_MS')]).toEqual(['16384', '30000']);
    expect(/max\(200, min\(int\(viewport\.get\('width', 1280\)\), (\d+)\)\)/.exec(source)?.[1]).toBe('3840');
  });

  it.skipIf(skipUnless('a Python 3 interpreter', PYTHON !== undefined))('is valid Python 3', () => {
    const checked = execFileSync(PYTHON as string, ['-I', '-c', 'import ast, sys; ast.parse(open(sys.argv[1]).read()); print("parsed")', DRIVER], { encoding: 'utf8' });
    expect(checked.trim()).toBe('parsed');
  });
});
