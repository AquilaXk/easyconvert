import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentImageFetchSession,
  HTML_IMAGE_FETCH_ENV,
  IMAGES_TURNED_OFF,
  ImageFetchRefusal,
  ImageFetchSession,
  overrideImageFetchRules,
  runWithImageFetchSession,
} from '../src/lib/conversions/html-image-fetch';
import { solidPng, startImageServer, type ImageServer } from './helpers/image-server';

/**
 * The session that drives the fetcher child process: the child's environment, the per-job caps, the job's abort
 * signal and the off switch. The guards inside the child are tested in html-image-fetch.test.ts. A local server on
 * 127.0.0.1 stands in for a public host: the child answers `images.test` from a table and lets only that address in.
 */

const LOOPBACK = '127.0.0.1';
const HOST = 'images.test';

let server: ImageServer;
let restore: (() => void) | undefined;
let png: Buffer;

const at = (pathAndQuery: string): string => `http://${HOST}:${server.port}${pathAndQuery}`;

async function refusal(promise: Promise<unknown>): Promise<ImageFetchRefusal> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason
  );
  expect(error).toBeInstanceOf(ImageFetchRefusal);
  return error as ImageFetchRefusal;
}

beforeEach(async () => {
  server = await startImageServer();
  png = await solidPng(4, 3, { r: 10, g: 200, b: 90 });
  server.serve('/a.png', png);
  restore = overrideImageFetchRules({ hosts: { [HOST]: [LOOPBACK] }, permitAddresses: [LOOPBACK], anyPort: true });
});

afterEach(async () => {
  restore?.();
  await server.close();
});

describe('a fetch runs in the child process', () => {
  it('returns the bytes and the signature type', async () => {
    const fetched = await new ImageFetchSession().fetch(at('/a.png'));
    expect(fetched.bytes.equals(png)).toBe(true);
    expect(fetched.mime).toBe('image/png');
    expect(server.requests[0].headers.host).toBe(`${HOST}:${server.port}`);
  });

  it('starts the child without the environment of the worker', async () => {
    // A preload named in NODE_OPTIONS would run in the child and leave this file; the child must not see the variable.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-env-'));
    const marker = path.join(dir, 'ran');
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const previous = { NODE_OPTIONS: process.env.NODE_OPTIONS, SECRET_TOKEN: process.env.SECRET_TOKEN, HTTPS_PROXY: process.env.HTTPS_PROXY };
    process.env.NODE_OPTIONS = `--require ${preload}`;
    process.env.SECRET_TOKEN = 'must-not-reach-the-child';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    try {
      await new ImageFetchSession().fetch(at('/a.png'));
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    try {
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies the production address rules inside the child', async () => {
    restore?.();
    restore = overrideImageFetchRules({ hosts: { [HOST]: [LOOPBACK] }, anyPort: true });
    const viaName = await refusal(new ImageFetchSession().fetch(at('/a.png')));
    const viaLiteral = await refusal(new ImageFetchSession().fetch(`http://${LOOPBACK}:${server.port}/a.png`));
    expect(viaName.message).toBe('the host is not a public address');
    expect(viaLiteral.message).toBe('the host is not a public address');
    expect(server.connections()).toBe(0);
  });

  it('reports a failure of the fetch as the reason the child gave', async () => {
    expect((await refusal(new ImageFetchSession().fetch(at('/missing.png')))).message).toBe('the server answered with status 404');
    expect((await refusal(new ImageFetchSession().fetch('http://nowhere.test/a.png'))).message).toBe('the host could not be resolved');
  });
});

describe('the caps of a session', () => {
  it('fetches the same URL once', async () => {
    const session = new ImageFetchSession();
    await Promise.all([session.fetch(at('/a.png')), session.fetch(at('/a.png'))]);
    await session.fetch(at('/a.png'));
    expect(server.requests).toHaveLength(1);
  });

  it('counts a refused fetch too, and refuses the fetch past the limit without starting a child', async () => {
    const session = new ImageFetchSession({ maxImages: 2 });
    await refusal(session.fetch(at('/missing.png')));
    await session.fetch(at('/a.png'));
    const before = server.requests.length;
    expect((await refusal(session.fetch(at('/b.png')))).message).toBe('the limit of 2 images per document was reached');
    expect(server.requests).toHaveLength(before);
  });

  it('refuses images past the total size', async () => {
    server.serve('/b.png', png);
    const session = new ImageFetchSession({ maxTotalBytes: png.length + 10 });
    await session.fetch(at('/a.png'));
    expect((await refusal(session.fetch(at('/b.png')))).message).toMatch(/total size/);
  });

  it('refuses an image above the per-image size', async () => {
    const error = await refusal(new ImageFetchSession({ maxImageBytes: png.length - 1 }).fetch(at('/a.png')));
    expect(error.message).toBe(`the image is larger than ${png.length - 1} bytes`);
  });

  it('shares one total time across the fetches', async () => {
    server.route('/hang.png', () => undefined);
    const session = new ImageFetchSession({ perFetchMs: 5000, totalMs: 1500 });
    const started = Date.now();
    await refusal(session.fetch(at('/hang.png')));
    expect(Date.now() - started).toBeLessThan(8000);
    expect((await refusal(session.fetch(at('/a.png')))).message).toMatch(/too long/);
  });
});

describe('the job', () => {
  it('shares one session for everything inside runWithImageFetchSession, so the caps hold across routes', async () => {
    const outside = currentImageFetchSession();
    await runWithImageFetchSession(undefined, async () => {
      const first = currentImageFetchSession();
      await first.fetch(at('/a.png'));
      // A later route of the same job asks for the same image: it is not fetched again.
      await currentImageFetchSession().fetch(at('/a.png'));
      expect(currentImageFetchSession()).toBe(first);
      expect(first).not.toBe(outside);
    });
    expect(server.requests).toHaveLength(1);
  });

  it('starts no fetch once the job signal has fired', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job cancelled'));
    const session = new ImageFetchSession({}, { signal: controller.signal });
    await expect(session.fetch(at('/a.png'))).rejects.toThrow('job cancelled');
    expect(server.requests).toHaveLength(0);
  });

  it('stops a fetch in flight when the job signal fires', async () => {
    server.route('/hang.png', () => undefined);
    const controller = new AbortController();
    const session = new ImageFetchSession({}, { signal: controller.signal });
    const pending = session.fetch(at('/hang.png'));
    const settled = pending.then(
      () => 'resolved',
      (error: unknown) => (error as Error).message
    );
    while (server.requests.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    controller.abort(new Error('job cancelled'));
    expect(await settled).toBe('job cancelled');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe(HTML_IMAGE_FETCH_ENV, () => {
  const previous = process.env[HTML_IMAGE_FETCH_ENV];
  afterEach(() => {
    if (previous === undefined) delete process.env[HTML_IMAGE_FETCH_ENV];
    else process.env[HTML_IMAGE_FETCH_ENV] = previous;
  });

  it.each(['off', 'OFF', ' Off '])('%j turns fetching off: nothing is fetched and the reason says so', async (value) => {
    process.env[HTML_IMAGE_FETCH_ENV] = value;
    expect((await refusal(new ImageFetchSession().fetch(at('/a.png')))).message).toBe(IMAGES_TURNED_OFF);
    expect(server.requests).toHaveLength(0);
  });

  it.each(['on', 'ON', ''])('%j leaves fetching on', async (value) => {
    process.env[HTML_IMAGE_FETCH_ENV] = value;
    expect((await new ImageFetchSession().fetch(at('/a.png'))).mime).toBe('image/png');
  });
});
