import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createZipBuffer,
  hasCompressedMagic,
  isPrecompressedEntry,
  writeZipFile,
  ZipWriter,
  ZIP_WRITER_MAX_ENTRIES,
  type ZipEntryInput,
} from '../src/lib/conversions/zip-writer';
import { createZipArchive } from '../src/lib/conversions/archive';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { proseText, SeededRandom } from './helpers/archive-corpus';

// skip-ok: the multi-gigabyte ZIP64 cases run in the nightly job (ZIP64_NIGHTLY=1); the PR job runs the forced-ZIP64 cases.
const SKIP_NIGHTLY = process.env.ZIP64_NIGHTLY !== '1';
const TEST_TIMEOUT_MS = 180_000;
const NIGHTLY_TIMEOUT_MS = 1_800_000;
const MEGABYTE = 1024 * 1024;
const GIGABYTE = 1024 * MEGABYTE;
const CLASSIC_ENTRY_LIMIT = 65_535;

const PYTHON_ARCHIVE_CHECK = `
import sys, zipfile, hashlib, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
infos = z.infolist()
out = {"count": len(infos), "bad": bad, "methods": {}, "first": infos[0].filename if infos else None}
if len(sys.argv) > 2:
    for name in sys.argv[2:]:
        data = z.read(name)
        out.setdefault("sha256", {})[name] = hashlib.sha256(data).hexdigest()
        out["methods"][name] = z.getinfo(name).compress_type
print(json.dumps(out))
`;

interface PythonReport {
  count: number;
  bad: string | null;
  first: string | null;
  methods: Record<string, number>;
  sha256?: Record<string, string>;
}

function pythonReport(archive: string, names: string[] = []): PythonReport {
  const python = getOracleToolPath('python3')!;
  return JSON.parse(execFileSync(python, ['-I', '-c', PYTHON_ARCHIVE_CHECK, archive, ...names], { encoding: 'utf8', maxBuffer: 1 << 26 })) as PythonReport;
}

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zip-writer-'));
}

function tinyEntries(count: number): ZipEntryInput[] {
  return Array.from({ length: count }, (_, i) => ({ name: `d${i % 100}/f${i}.txt`, data: Buffer.from(`entry ${i}\n`) }));
}

/** End-of-central-directory fields read straight from the last bytes of the archive (APPNOTE 4.3.16). */
function endRecord(archive: Buffer): { total: number; directorySize: number; directoryOffset: number; hasLocator: boolean } {
  const at = archive.length - 22;
  expect(archive.readUInt32LE(at)).toBe(0x06054b50);
  const hasLocator = archive.length >= 22 + 20 && archive.readUInt32LE(at - 20) === 0x07064b50;
  return { total: archive.readUInt16LE(at + 10), directorySize: archive.readUInt32LE(at + 12), directoryOffset: archive.readUInt32LE(at + 16), hasLocator };
}

describe('precompressed entry detection', () => {
  const sample = (...bytes: number[]): Uint8Array => Uint8Array.from(bytes);

  it.each([
    ['photo.JPG', sample(1, 2, 3)],
    ['clip.mp4', sample(0)],
    ['song.mp3', sample(0)],
    ['voice.opus', sample(0)],
    ['bundle.zst', sample(0)],
    ['page.pdf.gz', sample(0)],
    ['cover.avif', sample(0)],
  ])('stores %s by its extension', (name, head) => {
    expect(isPrecompressedEntry(name, head)).toBe(true);
  });

  it.each([
    ['JPEG', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])],
    ['PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['WebP', Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1')],
    ['MP4', Buffer.from('\u0000\u0000\u0000\u0018ftypisom\u0000\u0000\u0002\u0000', 'latin1')],
    ['AVIF', Buffer.from('\u0000\u0000\u0000\u001cftypavif\u0000\u0000\u0000\u0000', 'latin1')],
    ['MP3 with ID3', Buffer.from('ID3\u0004\u0000\u0000', 'latin1')],
    ['Ogg Opus', Buffer.from('OggS\u0000\u0002', 'latin1')],
    ['ZIP', Buffer.from('PK\u0003\u0004', 'latin1')],
    ['7z', Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])],
    ['gzip', Uint8Array.from([0x1f, 0x8b, 8, 0])],
    ['xz', Uint8Array.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])],
    ['zstd', Uint8Array.from([0x28, 0xb5, 0x2f, 0xfd, 0, 0])],
  ])('stores %s content by its magic number whatever the name', (_kind, head) => {
    expect(hasCompressedMagic(head)).toBe(true);
    expect(isPrecompressedEntry('data.bin', head)).toBe(true);
  });

  it.each([
    ['notes.txt', Buffer.from('hello world, plain text', 'latin1')],
    ['table.csv', Buffer.from('a,b,c\n1,2,3\n', 'latin1')],
    ['data.json', Buffer.from('{"a": 1}', 'latin1')],
    ['raw.wav', Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt ', 'latin1')],
  ])('deflates %s', (name, head) => {
    expect(isPrecompressedEntry(name, head)).toBe(false);
  });
});

describe('ZIP writer against the reference readers', () => {
  oracleTest('writes 65,536 entries that zipinfo, unzip, 7z and Python zipfile all read as 65,536', ['python3', 'zipinfo', 'unzip', '7z'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'many.zip');
    await writeZipFile(file, tinyEntries(65_536));
    const python = pythonReport(file);
    expect(python.count).toBe(65_536);
    expect(python.bad).toBeNull();
    const listing = execFileSync(getOracleToolPath('zipinfo')!, ['-t', file], { encoding: 'utf8' });
    expect(listing).toContain('65536 files');
    execFileSync(getOracleToolPath('unzip')!, ['-tq', file]);
    execFileSync(getOracleToolPath('7z')!, ['t', file]);
    const archive = fs.readFileSync(file);
    const end = endRecord(archive);
    expect(end.total, 'the 16-bit total holds the ZIP64 marker').toBe(0xffff);
    expect(end.hasLocator).toBe(true);
  }, TEST_TIMEOUT_MS);

  oracleTest('writes 70,000 entries that Python zipfile and 7z read in full', ['python3', '7z'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'seventy.zip');
    await writeZipFile(file, tinyEntries(70_000));
    expect(pythonReport(file).count).toBe(70_000);
    const out = execFileSync(getOracleToolPath('7z')!, ['t', file], { encoding: 'utf8' });
    expect(out).toContain('Files: 70000');
  }, TEST_TIMEOUT_MS);

  it('keeps an archive under 65,535 entries free of ZIP64 records', async () => {
    const archive = await createZipBuffer(tinyEntries(CLASSIC_ENTRY_LIMIT - 1));
    const end = endRecord(archive);
    expect(end.total).toBe(CLASSIC_ENTRY_LIMIT - 1);
    expect(end.hasLocator).toBe(false);
  }, TEST_TIMEOUT_MS);

  oracleTest('forced ZIP64 archives (every entry, end record and locator) pass unzip, 7z and Python', ['python3', 'unzip', '7z', 'zipinfo'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'forced.zip');
    const text = proseText(50_000, 3);
    const noise = new SeededRandom(8).bytes(30_000);
    await writeZipFile(
      file,
      [
        { name: 'notes/', data: undefined },
        { name: 'notes/prose.txt', data: text },
        { name: 'noise.bin', data: noise },
        { name: 'ünï/cödé.txt', data: Buffer.from('utf-8 name') },
        { name: 'empty.txt', data: Buffer.alloc(0) },
      ],
      { zip64: 'always' }
    );
    execFileSync(getOracleToolPath('unzip')!, ['-tq', file]);
    execFileSync(getOracleToolPath('7z')!, ['t', file]);
    const report = pythonReport(file, ['notes/prose.txt', 'noise.bin', 'ünï/cödé.txt', 'empty.txt']);
    expect(report.count).toBe(5);
    expect(report.bad).toBeNull();
    expect(report.sha256!['notes/prose.txt']).toBe(sha256(text));
    expect(report.sha256!['noise.bin']).toBe(sha256(noise));
    expect(report.sha256!['ünï/cödé.txt']).toBe(sha256(Buffer.from('utf-8 name')));
    const verbose = execFileSync(getOracleToolPath('zipinfo')!, ['-v', file], { encoding: 'utf8' });
    expect(verbose).toContain('PKWARE 64-bit sizes');
    expect(execFileSync(getOracleToolPath('7z')!, ['t', file], { encoding: 'utf8' })).toContain('Characteristics = Zip64');
    const end = fs.readFileSync(file);
    expect(endRecord(end).hasLocator).toBe(true);
  });

  oracleTest('streamed entries (undeclared and declared size) carry correct data descriptors', ['python3', 'unzip', '7z'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'streamed.zip');
    const rng = new SeededRandom(21);
    const chunks = Array.from({ length: 40 }, () => rng.bytes(7_000 + rng.below(9_000)));
    const prose = proseText(300_000, 5);
    const proseChunks = Array.from({ length: 30 }, (_, i) => prose.subarray(i * 10_000, (i + 1) * 10_000));
    async function* asyncChunks(list: Uint8Array[]): AsyncGenerator<Uint8Array> {
      for (const chunk of list) yield chunk;
    }
    await writeZipFile(file, [
      { name: 'undeclared.bin', data: asyncChunks(chunks), method: 'deflate' },
      { name: 'declared.txt', data: asyncChunks(proseChunks), declaredSize: 300_000 },
      { name: 'sync-iterable.txt', data: proseChunks, declaredSize: 300_000 },
      { name: 'stored-stream.bin', data: asyncChunks(chunks), method: 'store', declaredSize: chunks.reduce((n, c) => n + c.length, 0) },
    ]);
    execFileSync(getOracleToolPath('unzip')!, ['-tq', file]);
    execFileSync(getOracleToolPath('7z')!, ['t', file]);
    const report = pythonReport(file, ['undeclared.bin', 'declared.txt', 'sync-iterable.txt', 'stored-stream.bin']);
    expect(report.bad).toBeNull();
    expect(report.sha256!['undeclared.bin']).toBe(sha256(Buffer.concat(chunks)));
    expect(report.sha256!['declared.txt']).toBe(sha256(prose));
    expect(report.sha256!['sync-iterable.txt']).toBe(sha256(prose));
    expect(report.sha256!['stored-stream.bin']).toBe(sha256(Buffer.concat(chunks)));
  });

  it('refuses a streamed entry whose size differs from the declared one', async () => {
    const writer = new ZipWriter(() => undefined);
    await expect(writer.addEntry({ name: 'x.bin', data: [Buffer.alloc(10)], declaredSize: 11 })).rejects.toThrow(/declared 11 bytes but its source produced 10/);
  });

  it('refuses entries past the writer limit and names that are empty or too long', async () => {
    const writer = new ZipWriter(() => undefined);
    await expect(writer.addEntry({ name: '', data: Buffer.alloc(1) })).rejects.toThrow(/empty name/);
    await expect(writer.addEntry({ name: 'x'.repeat(70_000), data: Buffer.alloc(1) })).rejects.toThrow(/too long/);
    expect(ZIP_WRITER_MAX_ENTRIES).toBeGreaterThanOrEqual(70_000);
  });

  oracleTest('lists JPEG and MP4 entries as Stored and text entries as Deflated in zipinfo -v', ['zipinfo', 'python3'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'methods.zip');
    const jpeg = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
    const mp4 = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'clip.mp4'));
    const text = proseText(40_000, 12);
    await writeZipFile(file, [
      { name: 'photo.jpg', data: jpeg },
      { name: 'clip.mp4', data: mp4 },
      { name: 'renamed-photo.dat', data: jpeg },
      { name: 'story.txt', data: text },
    ]);
    const verbose = execFileSync(getOracleToolPath('zipinfo')!, ['-v', file], { encoding: 'utf8' });
    const sections = verbose.split(/Central directory entry #\d+:/).slice(1);
    const methodOf = (name: string): string => {
      const section = sections.find((s) => /-+\n\n\s+(.+)\n/.exec(s)?.[1] === name);
      if (!section) throw new Error(`no section for ${name}`);
      return /compression method:\s+(.*)/.exec(section)![1];
    };
    expect(methodOf('photo.jpg')).toContain('none (stored)');
    expect(methodOf('clip.mp4')).toContain('none (stored)');
    expect(methodOf('renamed-photo.dat')).toContain('none (stored)');
    expect(methodOf('story.txt')).toContain('deflated');
    const report = pythonReport(file, ['photo.jpg', 'clip.mp4', 'story.txt']);
    expect(report.sha256!['photo.jpg']).toBe(sha256(jpeg));
    expect(report.sha256!['clip.mp4']).toBe(sha256(mp4));
    expect(report.sha256!['story.txt']).toBe(sha256(text));
  });

  oracleTest('stores an entry whose deflate output is not smaller', ['python3'], async () => {
    const dir = scratchDir();
    const file = path.join(dir, 'random.zip');
    const noise = new SeededRandom(5).bytes(20_000);
    await writeZipFile(file, [{ name: 'random.txt', data: noise, method: 'deflate' }]);
    const report = pythonReport(file, ['random.txt']);
    expect(report.methods['random.txt']).toBe(0);
    expect(report.sha256!['random.txt']).toBe(sha256(noise));
  });
});

describe('createZipArchive', () => {
  oracleTest('stores JPEG and MP4 members, deflates text, and every reader accepts the archive', ['zipinfo', 'python3', 'unzip', '7z'], async () => {
    const jpeg = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
    const mp4 = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'clip.mp4'));
    const text = proseText(60_000, 31);
    const result = await createZipArchive([
      { filename: 'a/photo.jpg', buffer: jpeg },
      { filename: 'a/clip.mp4', buffer: mp4 },
      { filename: 'b/story.txt', buffer: text },
      { filename: 'c.csv', buffer: Buffer.from('x,y\n1,2\n') },
    ]);
    const file = path.join(scratchDir(), 'out.zip');
    fs.writeFileSync(file, result.buffer);
    execFileSync(getOracleToolPath('unzip')!, ['-tq', file]);
    execFileSync(getOracleToolPath('7z')!, ['t', file]);
    const report = pythonReport(file, ['a/photo.jpg', 'a/clip.mp4', 'b/story.txt']);
    expect(report.methods['a/photo.jpg']).toBe(0);
    expect(report.methods['a/clip.mp4']).toBe(0);
    expect(report.methods['b/story.txt']).toBe(8);
    expect(report.sha256!['a/photo.jpg']).toBe(sha256(jpeg));
    expect(report.sha256!['b/story.txt']).toBe(sha256(text));
    expect(result.size).toBe(result.buffer.length);
  });

  it('refuses more entries than the extractor accepts, with a typed error', async () => {
    const files = Array.from({ length: 50_001 }, (_, i) => ({ filename: `f${i}.txt`, buffer: Buffer.from('x') }));
    await expect(createZipArchive(files)).rejects.toMatchObject({ name: 'PayloadLimitError' });
  });
});

describe.skipIf(SKIP_NIGHTLY)('ZIP64 at its real thresholds (nightly)', () => {
  /** `size` bytes of zeros in 4 MiB chunks, produced on demand so that no more than one chunk exists. */
  async function* zeros(size: number): AsyncGenerator<Uint8Array> {
    const chunk = Buffer.alloc(4 * MEGABYTE);
    for (let sent = 0; sent < size; sent += chunk.length) yield chunk.subarray(0, Math.min(chunk.length, size - sent));
  }

  oracleTest(
    'a 4.5 GiB member passes `7z t` and `unzip -t`',
    ['7z', 'unzip', 'python3'],
    async () => {
      const file = path.join(scratchDir(), 'big.zip');
      const size = Math.round(4.5 * GIGABYTE);
      await writeZipFile(file, [{ name: 'zeros.bin', data: zeros(size), method: 'deflate' }]);
      execFileSync(getOracleToolPath('unzip')!, ['-tq', file], { maxBuffer: 1 << 26 });
      execFileSync(getOracleToolPath('7z')!, ['t', file], { maxBuffer: 1 << 26 });
      const info = spawnSync(getOracleToolPath('zipinfo')!, ['-l', file], { encoding: 'utf8' });
      expect(info.stdout).toContain(String(size));
    },
    NIGHTLY_TIMEOUT_MS
  );

  oracleTest(
    'a 2 GiB stored output is written with peak resident memory under 256 MB',
    ['unzip'],
    async () => {
      const file = path.join(scratchDir(), 'stored.zip');
      let peak = 0;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 50);
      const baseline = process.memoryUsage().rss;
      try {
        await writeZipFile(file, [{ name: 'zeros.bin', data: zeros(2 * GIGABYTE), method: 'store' }]);
      } finally {
        clearInterval(timer);
      }
      expect(peak - baseline).toBeLessThan(256 * MEGABYTE);
      execFileSync(getOracleToolPath('unzip')!, ['-tq', file], { maxBuffer: 1 << 26 });
    },
    NIGHTLY_TIMEOUT_MS
  );
});

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
