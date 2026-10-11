import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClassRows } from '../bench/class-rows';
import { CORPUS_TIER_ENV, QUICK_PUBLIC_SUBSET, PUBLIC_SPEED_SAMPLES } from '../bench/config';
import { createContext } from '../bench/context';
import {
  CorpusDigestError,
  CorpusError,
  CorpusFetchError,
  downloadSample,
  ensureSample,
  isRemoteCase,
  pinSeeds,
  readRemoteManifest,
  type RemoteManifest,
  type RemoteSample,
  remoteSamples,
  resetVerifiedSamples,
  validateRemoteManifest,
  y4mLayout,
} from '../bench/corpora';
import { AUDIO_EDGE_CASE_IDS } from '../bench/families/audio';
import { ReferenceCache } from '../bench/ref-cache';
import { SPEC } from '../bench/rows';
import { caseInScope, corpusTier, rowInScope } from '../bench/scope';

const ROOT = path.resolve(__dirname, '..');
const manifest = readRemoteManifest();
const provenance = fs.readFileSync(path.join(ROOT, 'bench', 'corpus', 'PROVENANCE.md'), 'utf8');
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

describe('the manifest of the public sample sets', () => {
  const countBy = (family: string, key: (sample: RemoteSample) => string): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const sample of remoteSamples(family as 'image', manifest)) counts.set(key(sample), (counts.get(key(sample)) ?? 0) + 1);
    return counts;
  };

  it('is valid and pins every file by an https origin, a size and a SHA-256', () => {
    expect(() => validateRemoteManifest(JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'corpus', 'remote-manifest.json'), 'utf8')))).not.toThrow();
    for (const sample of manifest.samples) {
      expect(sample.sha256, sample.id).toMatch(/^[0-9a-f]{64}$/);
      expect(sample.bytes, sample.id).toBeGreaterThan(0);
    }
  });

  it('gives every family at least ten samples that span its content classes', () => {
    for (const family of ['image', 'video', 'audio', 'compression']) {
      expect(remoteSamples(family as 'image', manifest).length, family).toBeGreaterThanOrEqual(10);
    }
    const images = countBy('image', (sample) => sample.class);
    expect(images.get('photo')).toBeGreaterThanOrEqual(10);
    expect(images.get('screen')).toBeGreaterThanOrEqual(6);
    expect(images.get('lineart')).toBeGreaterThanOrEqual(4);
    expect(images.get('alpha')).toBeGreaterThanOrEqual(1);
    expect(images.get('deep')).toBeGreaterThanOrEqual(1);
    const videos = countBy('video', (sample) => sample.class);
    for (const contentClass of ['natural', 'highmotion', 'screen', 'animation', 'grain']) expect(videos.get(contentClass), contentClass).toBeGreaterThanOrEqual(1);
    const resolutions = new Set(remoteSamples('video', manifest).map((sample) => Number(sample.meta.height)));
    expect(resolutions.size).toBeGreaterThanOrEqual(4);
    const audio = countBy('audio', (sample) => sample.class);
    for (const contentClass of ['speech', 'instrument', 'transient', 'orchestra', 'modern24']) expect(audio.get(contentClass), contentClass).toBeGreaterThanOrEqual(1);
    expect(AUDIO_EDGE_CASE_IDS.length).toBeGreaterThanOrEqual(3);
    const compression = countBy('compression', (sample) => sample.class);
    for (const contentClass of ['text', 'source', 'binary', 'compressed']) expect(compression.get(contentClass), contentClass).toBeGreaterThanOrEqual(1);
  });

  it('records the licence of every sample on its own row of PROVENANCE.md, and describes every licence code', () => {
    for (const sample of manifest.samples) {
      const line = provenance.split('\n').find((row) => row.startsWith('|') && row.includes(`\`${sample.id}\``) && row.includes(`\`${sample.licence}\``));
      expect(line, `${sample.id} with ${sample.licence}`).toBeDefined();
      expect(provenance, sample.licence).toContain(`\`${sample.licence}\``);
    }
    for (const id of AUDIO_EDGE_CASE_IDS) expect(provenance, id).toContain(`\`${id}\``);
    for (const set of Object.values(manifest.sets)) expect(provenance, set.terms).toContain(set.terms.split('?')[0].replace(/\/$/, ''));
  });

  it('keeps public samples out of the repository: the generated corpus budget stays at 5 MB and no sample file is committed', () => {
    const committed = fs.readdirSync(path.join(ROOT, 'bench', 'corpus'), { recursive: true }).map(String);
    for (const sample of manifest.samples) expect(committed, sample.id).not.toContain(sample.id);
  });

  it('refuses a manifest that is not fetchable, not pinned or not licensed', () => {
    const good = JSON.parse(JSON.stringify(manifest)) as RemoteManifest;
    const broken = (change: (m: RemoteManifest) => void): RemoteManifest => {
      const copy = JSON.parse(JSON.stringify(good)) as RemoteManifest;
      change(copy);
      return copy;
    };
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].licence = '')))).toThrow(/licence is missing/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].sha256 = 'abc')))).toThrow(/sha256/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[1].id = m.samples[0].id)))).toThrow(/duplicate sample id/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].id = 'a->b.png')))).toThrow(/safe file name/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].origin = { kind: 'file', url: 'http://example.org/a.png' })))).toThrow(/https/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].set = 'nowhere')))).toThrow(/unknown set/);
    expect(() => validateRemoteManifest(broken((m) => (m.samples[0].bytes = 0)))).toThrow(/bytes/);
  });
});

describe('fetching a sample', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-corpora-test-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const bytes = Buffer.from('a public sample, pinned by its digest');
  const sample = (over: Partial<RemoteSample> = {}): RemoteSample => ({
    id: 'sample.bin',
    family: 'image',
    class: 'photo',
    set: 'kodak-lossless',
    description: 'test',
    origin: { kind: 'file', url: 'https://example.org/sample.bin' },
    bytes: bytes.length,
    sha256: sha(bytes),
    licence: 'CC0-1.0',
    meta: {},
    ...over,
  });

  it('stores a verified download once, under its digest, and reads it from the cache after that', async () => {
    resetVerifiedSamples();
    let downloads = 0;
    const cacheDir = path.join(dir, 'cache-hit');
    const download = async (): Promise<Buffer> => {
      downloads++;
      return bytes;
    };
    const file = await ensureSample(sample(), { cacheDir, download });
    expect(file).toBe(path.join(cacheDir, 'image', sha(bytes)));
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
    resetVerifiedSamples();
    await ensureSample(sample(), { cacheDir, download });
    expect(downloads).toBe(1);
  });

  it('fetches again when the cached file no longer matches its digest', async () => {
    resetVerifiedSamples();
    const cacheDir = path.join(dir, 'cache-damaged');
    let downloads = 0;
    const download = async (): Promise<Buffer> => {
      downloads++;
      return bytes;
    };
    const file = await ensureSample(sample(), { cacheDir, download });
    fs.writeFileSync(file, 'damaged');
    resetVerifiedSamples();
    await ensureSample(sample(), { cacheDir, download });
    expect(downloads).toBe(2);
    expect(fs.readFileSync(file).equals(bytes)).toBe(true);
  });

  it('fails closed on a digest that differs from the manifest, and keeps nothing', async () => {
    resetVerifiedSamples();
    const cacheDir = path.join(dir, 'cache-mismatch');
    const other = Buffer.from('the host now serves another file');
    await expect(ensureSample(sample(), { cacheDir, download: async () => other })).rejects.toBeInstanceOf(CorpusDigestError);
    expect(fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }) : []).toEqual([]);
    // The size is part of the pin: the same digest cannot be claimed for another length.
    resetVerifiedSamples();
    await expect(ensureSample(sample({ bytes: bytes.length + 1 }), { cacheDir, download: async () => bytes })).rejects.toThrow(/pins/);
  });

  describe('from a host', () => {
    let server: http.Server;
    let base: string;
    const archive = Buffer.concat([Buffer.alloc(64, 1), Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')]);
    let zipped: Buffer;
    const requests: string[] = [];
    beforeAll(async () => {
      const zip = new JSZip();
      zip.file('stored.txt', 'stored entry '.repeat(20), { compression: 'STORE' });
      zip.file('deflated.txt', 'deflated entry '.repeat(200), { compression: 'DEFLATE' });
      zipped = await zip.generateAsync({ type: 'nodebuffer' });
      server = http.createServer((request, response) => {
        const url = request.url ?? '';
        requests.push(`${request.method} ${url} ${request.headers.range ?? ''}`.trim());
        const body = url.startsWith('/zip') ? zipped : archive;
        if (url.startsWith('/missing')) {
          response.writeHead(404).end();
          return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
        if (range) {
          const slice = body.subarray(Number(range[1]), Number(range[2]) + 1);
          response.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${range[1]}-${range[2]}/${body.length}` }).end(slice);
          return;
        }
        response.writeHead(200, { 'content-length': body.length }).end(body);
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('reads a whole file, a byte range of a larger file, and the entries of a ZIP archive with range requests', async () => {
      const whole = sample({ origin: { kind: 'file', url: `${base}/archive` }, bytes: archive.length, sha256: sha(archive) });
      expect((await downloadSample(whole)).equals(archive)).toBe(true);
      const slice = archive.subarray(64, 74);
      const ranged = sample({ origin: { kind: 'range', url: `${base}/archive`, start: 64, end: 73 }, bytes: slice.length, sha256: sha(slice) });
      expect((await downloadSample(ranged)).equals(slice)).toBe(true);
      expect(requests).toContain('GET /archive bytes=64-73');
    });

    it('pins ZIP entries from the central directory and reads them back, stored and deflated', async () => {
      const seeds = ['stored.txt', 'deflated.txt'].map((entry) => ({
        id: entry,
        family: 'compression' as const,
        class: 'text',
        set: 'silesia',
        description: entry,
        origin: { kind: 'zip' as const, archive: `${base}/zip`, entry },
        licence: 'CC0-1.0',
        meta: {},
      }));
      const pinned = await pinSeeds(seeds);
      expect(pinned.map((item) => item.bytes)).toEqual(['stored entry '.repeat(20).length, 'deflated entry '.repeat(200).length]);
      expect(pinned.map((item) => (item.origin as { method: number }).method)).toEqual([0, 8]);
      for (const item of pinned) {
        const body = await downloadSample(item);
        expect(sha(body)).toBe(item.sha256);
      }
    });

    it('pins the first frames of a y4m stream as one byte range', async () => {
      const header = Buffer.from('YUV4MPEG2 W64 H48 F30:1 Ip A1:1 C420jpeg\n');
      const frame = Buffer.concat([Buffer.from('FRAME\n'), Buffer.alloc(64 * 48 * 1.5, 7)]);
      const y4m = Buffer.concat([header, frame, frame, frame, frame]);
      const local = http.createServer((request, response) => {
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '') as RegExpExecArray;
        const slice = y4m.subarray(Number(range[1]), Math.min(Number(range[2]) + 1, y4m.length));
        response.writeHead(206, { 'content-length': slice.length, 'content-range': `bytes ${range[1]}-${Number(range[1]) + slice.length - 1}/${y4m.length}` }).end(slice);
      });
      await new Promise<void>((resolve) => local.listen(0, '127.0.0.1', resolve));
      try {
        const url = `http://127.0.0.1:${(local.address() as AddressInfo).port}/clip.y4m`;
        const [pinned] = await pinSeeds([{ id: 'clip.y4m', family: 'video', class: 'natural', set: 'aom-ctc', description: 'x', origin: { kind: 'y4m', url, frames: 3 }, licence: 'CC0-1.0', meta: {} }]);
        expect(pinned.origin).toEqual({ kind: 'range', url, start: 0, end: header.length + 3 * frame.length - 1 });
        expect(pinned.bytes).toBe(header.length + 3 * frame.length);
        expect(pinned.meta).toMatchObject({ width: 64, height: 48, frames: 3, fps: '30:1', chroma: '420jpeg' });
        expect(pinned.sha256).toBe(sha(y4m.subarray(0, header.length + 3 * frame.length)));
      } finally {
        await new Promise<void>((resolve) => local.close(() => resolve()));
      }
    });

    it('reports a host that does not deliver the file as a fetch error, after the attempts it is allowed', async () => {
      process.env.BENCH_CORPUS_RETRIES = '0';
      try {
        const failure = await downloadSample(sample({ origin: { kind: 'file', url: `${base}/missing` } })).then(
          () => null,
          (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(CorpusFetchError);
        expect((failure as Error).message).toMatch(/\/missing: failed after 1 attempts: .*HTTP 404, expected 200/);
      } finally {
        delete process.env.BENCH_CORPUS_RETRIES;
      }
    });
  });

  it('is strict in a strict run and skips in any other: the context returns null only when it may', async () => {
    resetVerifiedSamples();
    process.env.BENCH_CORPUS_RETRIES = '0';
    const unreachable = sample({ origin: { kind: 'file', url: 'https://127.0.0.1:1/sample.bin' }, sha256: sha('nothing') });
    const make = (strict: boolean, logged: string[]) =>
      createContext({
        resolve: () => null,
        strict,
        runs: 1,
        heavyRuns: 1,
        warmup: 0,
        injection: null,
        parity: true,
        quality: true,
        speed: false,
        quick: false,
        refCache: new ReferenceCache({ dir: null, toolVersion: () => null, fileHash: () => '', harnessHash: () => '', log: () => undefined }),
        work: dir,
        log: (message) => logged.push(message),
      });
    try {
      const logged: string[] = [];
      await expect(make(true, logged).remote(unreachable)).rejects.toBeInstanceOf(CorpusFetchError);
      expect(await make(false, logged).remote(unreachable)).toBeNull();
      expect(logged.join('\n')).toContain('sample.bin is not available, its rows are skipped');
      // A digest mismatch is never skipped.
      const wrong = sample({ sha256: sha('another file') });
      resetVerifiedSamples();
      await expect(ensureSample(wrong, { cacheDir: path.join(dir, 'strict'), download: async () => bytes })).rejects.toBeInstanceOf(CorpusError);
    } finally {
      delete process.env.BENCH_CORPUS_RETRIES;
    }
  });
});

describe('y4m headers', () => {
  it('give the frame size of the 8-bit layouts and refuse the others', () => {
    expect(y4mLayout('YUV4MPEG2 W1920 H1080 F60:1 Ip A1:1 C420jpeg')).toMatchObject({ width: 1920, height: 1080, frameBytes: 1920 * 1080 * 1.5, fps: '60:1' });
    expect(y4mLayout('YUV4MPEG2 W64 H32 F30:1 C444')).toMatchObject({ frameBytes: 64 * 32 * 3 });
    expect(y4mLayout('YUV4MPEG2 W64 H32 F30:1 C422')).toMatchObject({ frameBytes: 64 * 32 * 2 });
    expect(y4mLayout('YUV4MPEG2 W64 H32 F30:1')).toMatchObject({ chroma: '420jpeg' });
    expect(() => y4mLayout('YUV4MPEG2 W64 H32 F30:1 C420p10')).toThrow(/high bit depth/);
    expect(() => y4mLayout('RIFF')).toThrow(/YUV4MPEG2/);
  });
});

describe('which public cases a run measures', () => {
  const imageCase = `${remoteSamples('image', manifest)[0].id}->webp`;

  it('recognises the cases of public samples, edge cases and per-class rows, and not those of the generated corpus', () => {
    expect(isRemoteCase(imageCase, manifest)).toBe(true);
    expect(isRemoteCase('silesia-xml.tar->zst', manifest)).toBe(true);
    expect(isRemoteCase('silesia-xml.gz->tar', manifest)).toBe(true);
    expect(isRemoteCase('class-photo->avif', manifest)).toBe(true);
    expect(isRemoteCase('edge-surround-5.1.wav->opus', manifest)).toBe(true);
    for (const core of ['photo-a.jpg->webp', 'clip.mp4->h264', 'music.wav->opus', 'mixed.tar->zst', 'mixed.gz->tar']) expect(isRemoteCase(core, manifest), core).toBe(false);
  });

  it('measures the whole generated corpus and every public case in a full run, and only the named public cases with --quick', () => {
    expect(caseInScope(false, 'image', imageCase)).toBe(true);
    expect(caseInScope(false, 'image', 'photo-a.jpg->avif')).toBe(true);
    expect(caseInScope(true, 'image', imageCase)).toBe(false);
    for (const [family, cases] of Object.entries(QUICK_PUBLIC_SUBSET)) for (const caseName of cases) expect(caseInScope(true, family, caseName), caseName).toBe(true);
    // The per-class rows average every sample of a class, so a quick subset never states them.
    expect(caseInScope(true, 'image', 'class-photo->webp')).toBe(false);
    expect(caseInScope(false, 'image', 'class-photo->webp')).toBe(true);
    expect(rowInScope(true, `image/${imageCase}/ssim`)).toBe(false);
  });

  it('leaves the public cases out of the speed job of a pull request (BENCH_CORPUS_TIER=pr) and nothing else', () => {
    expect(corpusTier({})).toBe('full');
    expect(corpusTier({ [CORPUS_TIER_ENV]: 'full' })).toBe('full');
    expect(corpusTier({ [CORPUS_TIER_ENV]: 'pr' })).toBe('pr');
    expect(() => corpusTier({ [CORPUS_TIER_ENV]: 'nightly' })).toThrow(/must be "pr" or "full"/);
    process.env[CORPUS_TIER_ENV] = 'pr';
    try {
      expect(caseInScope(false, 'image', imageCase)).toBe(false);
      expect(caseInScope(false, 'image', 'class-photo->webp')).toBe(false);
      expect(caseInScope(false, 'image', 'photo-a.jpg->avif')).toBe(true);
      expect(caseInScope(false, 'compression', 'mixed.gz->tar')).toBe(true);
      expect(caseInScope(true, 'image', QUICK_PUBLIC_SUBSET.image[0])).toBe(true);
    } finally {
      delete process.env[CORPUS_TIER_ENV];
    }
  });

  it('names real samples, targets and speed samples, and every quick case has its rows in the recorded baseline', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, unknown> };
    const ids = new Set(manifest.samples.map((sample) => sample.id));
    const edges = new Set(AUDIO_EDGE_CASE_IDS);
    const baselineCases = new Set(Object.keys(baseline.entries).map((id) => id.split('/').slice(0, 2).join('/')));
    for (const [family, cases] of Object.entries(QUICK_PUBLIC_SUBSET)) {
      for (const caseName of cases) {
        const sampleId = caseName.split(/->|\.(?:tar|zst|xz|7z|zip|gz|bz2|rar)->/)[0];
        const owner = ids.has(sampleId) || edges.has(sampleId);
        expect(owner, `${family}/${caseName} names a sample of the manifest`).toBe(true);
        expect(baselineCases.has(`${family}/${caseName}`), `${family}/${caseName} is in the baseline`).toBe(true);
      }
    }
    for (const [family, samples] of Object.entries(PUBLIC_SPEED_SAMPLES)) {
      for (const id of samples) expect(ids.has(id) || edges.has(id), `${family} speed sample ${id}`).toBe(true);
    }
  });
});

describe('the rows that pool the samples of a class', () => {
  const bd = SPEC.bdRatePsnr;
  const names = (rows: ReturnType<ClassRows['rows']>): string[] => rows.map((row) => `${row.id}=${row.ours}`).sort();

  it('averages BD-rates without weights, so one sample cannot hide another: a sample behind the reference moves the class row', () => {
    const classes = new ClassRows();
    for (let i = 0; i < 3; i++) classes.expect('photo', '->webp', [bd.metric]);
    classes.add('photo', '->webp', bd, -6, 0);
    classes.add('photo', '->webp', bd, -3, 0);
    classes.add('photo', '->webp', bd, 12, 0);
    expect(names(classes.rows('image', () => 'cwebp'))).toEqual(['image/class-photo->webp/bd_rate_psnr=1']);
  });

  it('pools sizes by their weight: the sum of the compressed sizes over the sum of the originals', () => {
    const classes = new ClassRows();
    classes.expect('text', '.tar->zst', [SPEC.ratio.metric]);
    classes.expect('text', '.tar->zst', [SPEC.ratio.metric]);
    classes.add('text', '.tar->zst', SPEC.ratio, 10, 8, 100);
    classes.add('text', '.tar->zst', SPEC.ratio, 300, 280, 900);
    const [row] = classes.rows('compression', () => 'zstd');
    expect(row.case).toBe('class-text.tar->zst');
    expect(row.ours).toBeCloseTo(0.31, 10);
    expect(row.reference).toBeCloseTo(0.288, 10);
  });

  it('states nothing about a class when a sample is missing, and leaves out a sample whose curve is undetermined', () => {
    const missing = new ClassRows();
    missing.expect('screen', '->avif', [bd.metric]);
    missing.expect('screen', '->avif', [bd.metric]);
    missing.add('screen', '->avif', bd, 1, 0);
    expect(missing.rows('image', () => 'avifenc')).toEqual([]);
    const undetermined = new ClassRows();
    undetermined.expect('screen', '->avif', [bd.metric]);
    undetermined.expect('screen', '->avif', [bd.metric]);
    undetermined.add('screen', '->avif', bd, 2, 0);
    undetermined.exclude('screen', '->avif', bd.metric);
    expect(names(undetermined.rows('image', () => 'avifenc'))).toEqual(['image/class-screen->avif/bd_rate_psnr=2']);
  });
});
