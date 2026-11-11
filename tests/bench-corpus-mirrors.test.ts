import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CorpusDigestError,
  CorpusFetchError,
  downloadSample,
  ensureSample,
  readRemoteManifest,
  resetVerifiedSamples,
  sha256,
  validateRemoteManifest,
  type PinnedFile,
  type RemoteManifest,
} from '../bench/corpora';

/** A refused origin costs one pause between its two attempts (2 s); a hang is far beyond that. */
const MIRROR_FALLBACK_HANG_GUARD_MS = 30_000;

const bytes = Buffer.from('the pinned bytes of a book');

describe('a corpus file with mirror addresses', () => {
  let origin: http.Server;
  let mirror: http.Server;
  let originPath = '/ok';
  let mirrorPath = '/ok';
  const hits = { origin: 0, mirror: 0 };
  let originBase: string;
  let mirrorBase: string;
  let dir: string;

  const serve = (counter: 'origin' | 'mirror', body: () => { status: number; body: Buffer; location?: string }): http.Server =>
    http.createServer((_request, response) => {
      hits[counter]++;
      const answer = body();
      response.writeHead(answer.status, { 'content-length': answer.body.length, ...(answer.location === undefined ? {} : { location: answer.location }) }).end(answer.body);
    });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-mirrors-'));
    origin = serve('origin', () => (originPath === '/down' ? { status: 503, body: Buffer.alloc(0) } : { status: 200, body: bytes }));
    mirror = serve('mirror', () => {
      if (mirrorPath === '/wrong') return { status: 200, body: Buffer.from('some other bytes!!!!!!!!') };
      if (mirrorPath === '/redirect') return { status: 302, body: Buffer.alloc(0), location: 'https://elsewhere.example/file' };
      return { status: 200, body: bytes };
    });
    await Promise.all([origin, mirror].map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))));
    originBase = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    mirrorBase = `http://127.0.0.1:${(mirror.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await Promise.all([origin, mirror].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  const file = (mirrors: string[] | undefined = [`${mirrorBase}/m`]): PinnedFile => ({
    id: 'book.mobi',
    family: 'ebook',
    set: 'kodak-lossless',
    origin: { kind: 'file', url: `${originBase}/o`, ...(mirrors === undefined ? {} : { mirrors }) },
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
  const reset = (): void => {
    hits.origin = 0;
    hits.mirror = 0;
    resetVerifiedSamples();
  };

  it('never asks a mirror when the origin delivers', async () => {
    reset();
    expect((await downloadSample(file())).equals(bytes)).toBe(true);
    expect(hits).toEqual({ origin: 1, mirror: 0 });
  });

  it(
    'reads the mirror when the origin cannot be reached, after one retry of the origin, and keeps the verified bytes',
    async () => {
      reset();
      const unreachable = file();
      if (unreachable.origin.kind === 'file') unreachable.origin.url = 'http://127.0.0.1:1/o';
      const cached = await ensureSample(unreachable, { cacheDir: path.join(dir, 'cache') });
      expect(fs.readFileSync(cached).equals(bytes)).toBe(true);
      expect(hits.mirror).toBe(1);
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );

  it(
    'reads the mirror when the origin answers with a server error',
    async () => {
      reset();
      originPath = '/down';
      try {
        expect((await downloadSample(file())).equals(bytes)).toBe(true);
        expect(hits).toEqual({ origin: 2, mirror: 1 });
      } finally {
        originPath = '/ok';
      }
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );

  it(
    'fails closed on a mirror that serves other bytes',
    async () => {
      reset();
      originPath = '/down';
      mirrorPath = '/wrong';
      try {
        await expect(ensureSample(file(), { cacheDir: path.join(dir, 'cache-wrong') })).rejects.toBeInstanceOf(CorpusDigestError);
        expect(fs.existsSync(path.join(dir, 'cache-wrong'))).toBe(false);
      } finally {
        originPath = '/ok';
        mirrorPath = '/ok';
      }
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );

  it(
    'holds a mirror to the redirect rules of its own host and names every address that failed',
    async () => {
      reset();
      originPath = '/down';
      mirrorPath = '/redirect';
      try {
        const failure = await downloadSample(file()).then(
          () => null,
          (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(CorpusFetchError);
        expect((failure as Error).message).toMatch(/o: failed after 2 attempts.*HTTP 503.*m: .*redirect to elsewhere\.example is not allowed/);
      } finally {
        originPath = '/ok';
        mirrorPath = '/ok';
      }
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );
});

describe('the manifest entry of a mirrored file', () => {
  const manifest = readRemoteManifest();
  const mirrored = (mirrors: unknown): RemoteManifest => {
    const copy = JSON.parse(JSON.stringify(manifest)) as RemoteManifest;
    const first = copy.samples.find((sample) => sample.origin.kind === 'file');
    (first?.origin as { mirrors?: unknown }).mirrors = mirrors;
    return copy;
  };

  it('accepts one to three https addresses', () => {
    const accepted = validateRemoteManifest(mirrored(['https://mirror.example/a', 'https://mirror.example/b']));
    expect(accepted.samples.find((sample) => sample.origin.kind === 'file')?.origin).toMatchObject({ mirrors: ['https://mirror.example/a', 'https://mirror.example/b'] });
  });

  it.each([
    ['an empty list', []],
    ['more than three addresses', ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4']],
    ['a plain http address', ['http://mirror.example/a']],
    ['something that is not a list', 'https://mirror.example/a'],
    ['a repeated address', ['https://mirror.example/a', 'https://mirror.example/a']],
  ])('refuses %s', (_name, mirrors) => {
    expect(() => validateRemoteManifest(mirrored(mirrors))).toThrow(/mirrors/);
  });

  it('refuses the origin address listed again as its own mirror', () => {
    const copy = mirrored(['https://placeholder.example/x']);
    const first = copy.samples.find((sample) => sample.origin.kind === 'file');
    const origin = first?.origin as { url: string; mirrors: string[] };
    origin.mirrors = [origin.url];
    expect(() => validateRemoteManifest(copy)).toThrow(/mirrors repeats an address/);
  });
});
