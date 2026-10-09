import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_CACHE_ENTRY_BYTES, REF_CACHE_SCHEMA_VERSION } from '../bench/config';
import { corpusFileHash, harnessHash } from '../bench/harness-hash';
import { canonicalJson, numberRecord, ReferenceCache, type RefSpec, referenceCacheKey, type ResolvedRefSpec, stringValue } from '../bench/ref-cache';

/**
 * The key of a cached reference measurement names everything the measurement depends on: the reference tool and its
 * version, the content of the corpus file, the settings and the measuring code. The expected key below is hashed here
 * from a hand-written canonical string, not produced by the module under test.
 */

const RESOLVED: ResolvedRefSpec = {
  schemaVersion: REF_CACHE_SCHEMA_VERSION,
  kind: 'image/encode-measure',
  tools: { cwebp: 'cwebp 1.3.2', ffmpeg: 'ffmpeg 6.1.1' },
  files: { 'photo-a.jpg': 'aa'.repeat(32) },
  settings: { quality: 70, case: 'photo-a.jpg->webp', lossless: false },
  harness: 'bb'.repeat(32),
};

describe('the cache key', () => {
  it('is the SHA-256 of the canonical JSON of tool versions, file hashes, settings and harness hash', () => {
    const canonical =
      `{"files":{"photo-a.jpg":"${'aa'.repeat(32)}"},"harness":"${'bb'.repeat(32)}","kind":"image/encode-measure",` +
      `"schemaVersion":${REF_CACHE_SCHEMA_VERSION},"settings":{"case":"photo-a.jpg->webp","lossless":false,"quality":70},` +
      '"tools":{"cwebp":"cwebp 1.3.2","ffmpeg":"ffmpeg 6.1.1"}}';
    expect(canonicalJson(RESOLVED)).toBe(canonical);
    expect(referenceCacheKey(RESOLVED)).toBe(createHash('sha256').update(canonical).digest('hex'));
  });

  it('does not depend on the order the settings and tools are written in', () => {
    const shuffled: ResolvedRefSpec = {
      ...RESOLVED,
      settings: { lossless: false, case: 'photo-a.jpg->webp', quality: 70 },
      tools: { ffmpeg: 'ffmpeg 6.1.1', cwebp: 'cwebp 1.3.2' },
    };
    expect(referenceCacheKey(shuffled)).toBe(referenceCacheKey(RESOLVED));
  });

  it.each<[string, (spec: ResolvedRefSpec) => ResolvedRefSpec]>([
    ['the reference tool version', (spec) => ({ ...spec, tools: { ...spec.tools, cwebp: 'cwebp 1.4.0' } })],
    ['a tool that is not installed', (spec) => ({ ...spec, tools: { ...spec.tools, cwebp: null } })],
    ['another tool in the set', (spec) => ({ ...spec, tools: { ...spec.tools, dwebp: 'dwebp 1.3.2' } })],
    ['the corpus file hash', (spec) => ({ ...spec, files: { 'photo-a.jpg': 'cc'.repeat(32) } })],
    ['another corpus file', (spec) => ({ ...spec, files: { ...spec.files, 'photo-b.png': 'dd'.repeat(32) } })],
    ['a setting value', (spec) => ({ ...spec, settings: { ...spec.settings, quality: 71 } })],
    ['a setting type', (spec) => ({ ...spec, settings: { ...spec.settings, quality: '70' } })],
    ['the kind of measurement', (spec) => ({ ...spec, kind: 'image/ssimulacra2' })],
    ['the harness hash', (spec) => ({ ...spec, harness: 'ee'.repeat(32) })],
    ['the cache schema version', (spec) => ({ ...spec, schemaVersion: REF_CACHE_SCHEMA_VERSION + 1 })],
  ])('changes with %s', (_name, change) => {
    expect(referenceCacheKey(change(RESOLVED))).not.toBe(referenceCacheKey(RESOLVED));
  });
});

describe('the hashes that feed the key', () => {
  it('hashes a corpus file by its content and refuses a path outside the corpus', () => {
    const corpus = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-cache-corpus-'));
    try {
      fs.mkdirSync(path.join(corpus, 'data'));
      fs.writeFileSync(path.join(corpus, 'data', 'a.txt'), 'abc');
      // SHA-256 of "abc" (FIPS 180-2 appendix B.1).
      expect(corpusFileHash('data/a.txt', corpus)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(() => corpusFileHash('../outside.txt', corpus)).toThrow(RangeError);
    } finally {
      fs.rmSync(corpus, { recursive: true, force: true });
    }
  });

  it('changes the harness hash when the family runner or a shared measuring file changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-cache-harness-'));
    try {
      const write = (file: string, text: string): void => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
      };
      for (const file of ['bench/measure.ts', 'bench/rows.ts', 'bench/text-metrics.ts', 'bench/tools.ts', 'tests/helpers/ffmpeg-measure.ts', 'tests/helpers/ocr-cer.ts']) write(file, `// ${file}\n`);
      write('bench/families/image.ts', 'image v1\n');
      write('bench/families/audio.ts', 'audio v1\n');
      const first = harnessHash('image', root);
      expect(harnessHash('image', root)).toBe(first);
      expect(harnessHash('audio', root)).not.toBe(first);
      write('bench/families/image.ts', 'image v2\n');
      expect(harnessHash('image', root)).not.toBe(first);
      write('bench/families/image.ts', 'image v1\n');
      expect(harnessHash('image', root)).toBe(first);
      write('bench/measure.ts', '// changed\n');
      expect(harnessHash('image', root)).not.toBe(first);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the cache', () => {
  let dir: string;
  let logs: string[];
  let versions: Record<string, string | null>;
  let hashes: Record<string, string>;
  let harness: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ref-cache-'));
    logs = [];
    versions = { cwebp: 'cwebp 1.3.2' };
    hashes = { 'photo-a.jpg': '11'.repeat(32) };
    harness = '22'.repeat(32);
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const spec: RefSpec = { kind: 'encode-measure', tools: ['cwebp'], files: ['photo-a.jpg'], settings: { quality: 70 } };
  const parse = numberRecord(['bytes']);
  const cache = (cacheDir: string | null = dir): ReferenceCache =>
    new ReferenceCache({ dir: cacheDir, toolVersion: (tool) => versions[tool] ?? null, fileHash: (file) => hashes[file], harnessHash: () => harness, log: (message) => logs.push(message) });

  it('measures once and reads the value back for the same key', async () => {
    const first = cache();
    let measured = 0;
    const compute = (): { bytes: number } => {
      measured++;
      return { bytes: 1234 };
    };
    expect(await first.value('image', spec, parse, compute)).toEqual({ bytes: 1234 });
    expect(await cache().value('image', spec, parse, compute)).toEqual({ bytes: 1234 });
    expect(measured).toBe(1);
    expect(first.stats).toEqual({ hits: 0, misses: 1, corrupt: 0 });
    const files = fs.readdirSync(dir);
    expect(files).toEqual([`${referenceCacheKey(first.resolve('image', spec))}.json`]);
  });

  it('measures again when the tool version, a corpus file, a setting or the harness changes', async () => {
    let measured = 0;
    const compute = (): { bytes: number } => ({ bytes: ++measured });
    await cache().value('image', spec, parse, compute);
    versions.cwebp = 'cwebp 1.4.0';
    expect((await cache().value('image', spec, parse, compute)).bytes).toBe(2);
    hashes['photo-a.jpg'] = '33'.repeat(32);
    expect((await cache().value('image', spec, parse, compute)).bytes).toBe(3);
    harness = '44'.repeat(32);
    expect((await cache().value('image', spec, parse, compute)).bytes).toBe(4);
    expect((await cache().value('image', { ...spec, settings: { quality: 85 } }, parse, compute)).bytes).toBe(5);
    expect((await cache().value('image', spec, parse, compute)).bytes).toBe(4);
    expect(fs.readdirSync(dir)).toHaveLength(5);
  });

  it('keeps the families apart', async () => {
    let measured = 0;
    const compute = (): { bytes: number } => ({ bytes: ++measured });
    await cache().value('image', spec, parse, compute);
    expect((await cache().value('audio', spec, parse, compute)).bytes).toBe(2);
  });

  it('is off without a directory: every call measures and nothing is written', async () => {
    let measured = 0;
    const compute = (): { bytes: number } => ({ bytes: ++measured });
    const off = cache(null);
    await off.value('image', spec, parse, compute);
    await off.value('image', spec, parse, compute);
    expect(measured).toBe(2);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  async function entryFile(): Promise<string> {
    await cache().value('image', spec, parse, () => ({ bytes: 7 }));
    return path.join(dir, fs.readdirSync(dir)[0]);
  }

  it.each<[string, (file: string) => void]>([
    ['text that is not JSON', (file) => fs.writeFileSync(file, 'not json')],
    ['a value that fails its checksum', (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"bytes":7', '"bytes":8'))],
    ['an entry under another key', (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"key":"[0-9a-f]+"/, `"key":"${'0'.repeat(64)}"`))],
    ['an entry of another schema version', (file) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"schemaVersion":\d+,"key"/, '"schemaVersion":99,"key"'))],
    ['an entry over the size limit', (file) => fs.writeFileSync(file, ' '.repeat(MAX_CACHE_ENTRY_BYTES + 1))],
    ['a JSON array', (file) => fs.writeFileSync(file, '[1,2]')],
  ])('reports %s as corrupt, measures again and overwrites it', async (_name, damage) => {
    const file = await entryFile();
    damage(file);
    const again = cache();
    expect(await again.value('image', spec, parse, () => ({ bytes: 99 }))).toEqual({ bytes: 99 });
    expect(again.stats).toEqual({ hits: 0, misses: 1, corrupt: 1 });
    expect(logs.join('\n')).toMatch(/ignoring corrupt reference cache entry/);
    expect(await cache().value('image', spec, parse, () => ({ bytes: -1 }))).toEqual({ bytes: 99 });
  });

  it('treats a value of the wrong shape as corrupt', async () => {
    await entryFile();
    const again = cache();
    expect(await again.value('image', spec, numberRecord(['bytes', 'ssim']), () => ({ bytes: 7, ssim: 0.9 } as never))).toEqual({ bytes: 7, ssim: 0.9 });
    expect(again.stats.corrupt).toBe(1);
  });
});

describe('the value parsers', () => {
  it('accept exactly the named finite numbers and a string', () => {
    expect(numberRecord(['a', 'b'])({ a: 1, b: 2.5, extra: 'ignored' })).toEqual({ a: 1, b: 2.5 });
    expect(stringValue('text')).toBe('text');
    expect(() => numberRecord(['a'])({ a: Number.NaN })).toThrow(TypeError);
    expect(() => numberRecord(['a'])({ a: '1' })).toThrow(/finite number/);
    expect(() => numberRecord(['a'])({})).toThrow(TypeError);
    expect(() => numberRecord(['a'])(null)).toThrow(TypeError);
    expect(() => stringValue(1)).toThrow(TypeError);
  });
});
