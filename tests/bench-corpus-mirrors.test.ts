import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
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

describe('a ZIP entry with mirror addresses of its archive', () => {
  const body = 'the entry of a mirrored archive '.repeat(8);
  let archive: Buffer;
  let rebuilt: Buffer;
  let mirror: http.Server;
  let mirrorBase: string;
  let mirrorHits = 0;
  let wrongBytes = false;

  beforeAll(async () => {
    const zipOf = (text: string): Promise<Buffer> => new JSZip().file('entry.txt', text, { compression: 'STORE' }).generateAsync({ type: 'nodebuffer' });
    archive = await zipOf(body);
    rebuilt = await zipOf('X'.repeat(body.length));
    mirror = http.createServer((request, response) => {
      mirrorHits++;
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
      const served = wrongBytes ? rebuilt : archive;
      const start = Number(range?.[1] ?? 0);
      const slice = served.subarray(start, range ? Number(range[2]) + 1 : undefined);
      response.writeHead(range ? 206 : 200, { 'content-length': slice.length, 'content-range': `bytes ${start}-${start + slice.length - 1}/${served.length}` }).end(slice);
    });
    await new Promise<void>((resolve) => mirror.listen(0, '127.0.0.1', resolve));
    mirrorBase = `http://127.0.0.1:${(mirror.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => mirror.close(() => resolve())));

  const entry = (): PinnedFile => ({
    id: 'entry.txt',
    family: 'compression',
    set: 'silesia',
    origin: { kind: 'zip', archive: 'http://127.0.0.1:1/archive.zip', mirrors: [`${mirrorBase}/archive.zip`], entry: 'entry.txt', offset: 0, compressedSize: body.length, method: 0 },
    bytes: body.length,
    sha256: sha256(Buffer.from(body)),
  });

  it(
    'reads the entry from the mirror of the archive when the archive cannot be reached',
    async () => {
      mirrorHits = 0;
      resetVerifiedSamples();
      expect((await downloadSample(entry())).toString()).toBe(body);
      expect(mirrorHits).toBe(2);
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );

  it(
    'fails closed on a mirror whose archive holds other bytes',
    async () => {
      wrongBytes = true;
      resetVerifiedSamples();
      const cacheDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-zip-mirror-')), 'cache');
      try {
        await expect(ensureSample(entry(), { cacheDir })).rejects.toBeInstanceOf(CorpusDigestError);
        expect(fs.existsSync(cacheDir)).toBe(false);
      } finally {
        wrongBytes = false;
      }
    },
    MIRROR_FALLBACK_HANG_GUARD_MS
  );

  it('keeps the archive of every Silesia entry first and the web archive capture of the same archive as its mirror', () => {
    const silesia = readRemoteManifest().samples.filter((sample) => sample.set === 'silesia');
    expect(silesia).toHaveLength(12);
    for (const sample of silesia) {
      const origin = sample.origin as Extract<PinnedFile['origin'], { kind: 'zip' }>;
      expect(origin.archive).toBe('https://sun.aei.polsl.pl/~sdeor/corpus/silesia.zip');
      expect(origin.mirrors).toEqual(['https://web.archive.org/web/20250223203321id_/https://sun.aei.polsl.pl/~sdeor/corpus/silesia.zip']);
    }
  });
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

describe('the manifest entry of a ZIP archive with mirrors', () => {
  const withMirrors = (mirrors: unknown): RemoteManifest => {
    const copy = JSON.parse(JSON.stringify(readRemoteManifest())) as RemoteManifest;
    const first = copy.samples.find((sample) => sample.origin.kind === 'zip');
    (first?.origin as { mirrors?: unknown }).mirrors = mirrors;
    return copy;
  };

  it('accepts https addresses and refuses an empty list, a plain http address and the archive listed again', () => {
    expect(() => validateRemoteManifest(withMirrors(['https://mirror.example/a.zip']))).not.toThrow();
    expect(() => validateRemoteManifest(withMirrors([]))).toThrow(/mirrors/);
    expect(() => validateRemoteManifest(withMirrors(['http://mirror.example/a.zip']))).toThrow(/mirrors/);
    const own = (readRemoteManifest().samples.find((sample) => sample.origin.kind === 'zip')?.origin as { archive: string }).archive;
    expect(() => validateRemoteManifest(withMirrors([own]))).toThrow(/mirrors repeats an address/);
  });
});
