import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { convertArchive, extractZipArchive } from '../src/lib/conversions/archive';
import { UnsafeArchiveError } from '../src/lib/conversions/archive-extraction-safety';
import {
  ArchiveEntryCollisionError,
  ArchiveInputUnprocessableError,
  ArchivePasswordRequiredError,
  ConversionFailedError,
  CorruptStreamError,
  DecompressionLimitError,
  UnsupportedArchiveMethodError,
} from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { expectNoHangOnInput } from './helpers/timing';
import {
  craftZip,
  craftZipArchive,
  S_IFLNK,
  zip64Extra,
  zipCrc32,
  ZIP_FLAG_ENCRYPTED,
  ZIP_FLAG_UTF8,
  type CraftedEntry,
} from './helpers/zip-craft';

/**
 * ZIP reading fails closed. Every archive here is written byte by byte (tests/helpers/zip-craft.ts) or by the `zip`
 * CLI, so the layout does not come from the reader under test. `unzip -t` and `7z t` say whether a fixture is a
 * well-formed archive, and `unzip -p` gives the bytes an entry must decode to. The attack classes follow the known
 * ZIP exploits: path traversal, differentials between the local headers and the central directory, duplicate names,
 * overlapping entries that reuse bytes, ZIP64 fields that lie, and sizes that do not match the stream.
 */

const TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;
const ZIP_TOOLS = ['zip', 'unzip', '7z'] as const;

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-hardening-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('the archive was accepted');
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

function writeFixture(name: string, bytes: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function unzipTest(file: string): { status: number | null; output: string } {
  const unzip = getOracleToolPath('unzip') as string;
  const run = spawnSync(unzip, ['-t', file], { encoding: 'utf8' });
  return { status: run.status, output: run.stdout };
}

function sevenZipTest(file: string): number | null {
  return spawnSync(getOracleToolPath('7z') as string, ['t', '-tzip', file], { encoding: 'utf8' }).status;
}

function stored(name: string, text: string, extra: Partial<CraftedEntry> = {}): CraftedEntry {
  return { name, data: Buffer.from(text), method: 0, ...extra };
}

describe('archives written by other tools are read byte for byte', () => {
  oracleTest(
    'zip CLI archives (stored, deflated, empty, non-ASCII, nested) equal the files and unzip -p',
    [...ZIP_TOOLS],
    async () => {
      const source = path.join(workDir, 'cli-src');
      fs.mkdirSync(path.join(source, 'docs/deep'), { recursive: true });
      const random = crypto.randomBytes(40_000);
      fs.writeFileSync(path.join(source, 'docs/a.txt'), 'alpha line\n'.repeat(5000));
      fs.writeFileSync(path.join(source, 'docs/deep/b.bin'), random);
      fs.writeFileSync(path.join(source, 'empty.txt'), '');
      fs.writeFileSync(path.join(source, '한글 파일.txt'), 'unicode name');
      const archive = path.join(workDir, 'cli.zip');
      execFileSync(getOracleToolPath('zip') as string, ['-q', '-r', archive, '.'], { cwd: source });
      expect(unzipTest(archive).status).toBe(0);
      expect(sevenZipTest(archive)).toBe(0);

      const files = await extractZipArchive(fs.readFileSync(archive));
      const byName = new Map(files.map((f) => [f.filename, f.buffer]));
      expect([...byName.keys()].sort()).toEqual(['docs/a.txt', 'docs/deep/b.bin', 'empty.txt', '한글 파일.txt']);
      const unzip = getOracleToolPath('unzip') as string;
      for (const [name, buffer] of byName) {
        const expected = execFileSync(unzip, ['-p', archive, name], { maxBuffer: 16 * MIB });
        expect(sha256(buffer), name).toBe(sha256(expected));
      }
      expect(sha256(byName.get('docs/deep/b.bin') as Buffer)).toBe(sha256(random));
    },
    TIMEOUT_MS
  );

  oracleTest(
    'a zip CLI archive with ZIP64 records and one with data descriptors decode like unzip -p',
    [...ZIP_TOOLS],
    async () => {
      const source = path.join(workDir, 'z64-src');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'one.txt'), 'zip64 payload\n'.repeat(2000));
      const zip64 = path.join(workDir, 'z64.zip');
      execFileSync(getOracleToolPath('zip') as string, ['-q', '-fz', zip64, 'one.txt'], { cwd: source });
      expect(unzipTest(zip64).status).toBe(0);
      const streamed = path.join(workDir, 'stream.zip');
      const run = spawnSync(getOracleToolPath('zip') as string, ['-q', streamed, '-'], { input: Buffer.from('from a pipe\n'.repeat(500)) });
      expect(run.status).toBe(0);
      expect(unzipTest(streamed).status).toBe(0);

      const unzip = getOracleToolPath('unzip') as string;
      for (const [file, entry] of [[zip64, 'one.txt'], [streamed, '-']] as const) {
        const files = await extractZipArchive(fs.readFileSync(file));
        expect(files.map((f) => f.filename)).toEqual([entry]);
        expect(sha256(files[0].buffer)).toBe(sha256(execFileSync(unzip, ['-p', file, entry])));
      }
    },
    TIMEOUT_MS
  );

  oracleTest(
    'an archive behind a self-extractor stub is read with offsets shifted by the stub',
    [...ZIP_TOOLS],
    async () => {
      const { archive } = craftZipArchive([stored('a.txt', 'first'), { name: 'b.txt', data: Buffer.from('second '.repeat(50)) }], {
        prefix: Buffer.from('MZ-stub-'.repeat(40)),
      });
      const file = writeFixture('sfx.zip', archive);
      expect(sevenZipTest(file)).toBe(0);
      const files = await extractZipArchive(archive);
      expect(files.map((f) => [f.filename, f.buffer.toString()])).toEqual([['a.txt', 'first'], ['b.txt', 'second '.repeat(50)]]);
    },
    TIMEOUT_MS
  );

  it('an empty archive holds no files', async () => {
    const empty = craftZip([]);
    expect(await extractZipArchive(empty)).toEqual([]);
  });
});

describe('entry names that leave the extraction root are refused, never repaired', () => {
  const cases: Array<[string, string | Buffer, string]> = [
    ['a/../b', 'a/../b', 'path-traversal'],
    ['leading ..', '../evil', 'path-traversal'],
    ['backslash ..', 'a\\..\\b', 'path-traversal'],
    ['absolute', '/etc/x', 'absolute-path'],
    ['drive letter', 'C:\\x', 'absolute-path'],
    ['drive letter with slash', 'D:/x', 'absolute-path'],
    ['NUL byte', Buffer.from('safe.txt\0../../evil'), 'invalid-entry-name'],
    ['line break', 'a\nb', 'invalid-entry-name'],
    ['fullwidth dots and solidus (NFKC)', '．．／evil', 'path-traversal'],
  ];
  for (const [label, name, reason] of cases) {
    it(`${label}`, async () => {
      const archive = craftZip([stored('ok.txt', 'fine'), stored('x', 'payload', { name })]);
      const error = await rejection(() => extractZipArchive(archive));
      expect(error).toBeInstanceOf(UnsafeArchiveError);
      expect((error as UnsafeArchiveError).reason).toBe(reason);
      expect(statusOf(error)).toBeUndefined();
    });
  }

  it('a traversing name is refused through the conversion entry point too', async () => {
    const archive = craftZip([stored('a/../b', 'secret')]);
    const error = await rejection(() => convertArchive(archive, 'zip', 'tar', {}, 'in.zip'));
    expect(error).toBeInstanceOf(UnsafeArchiveError);
    expect((error as UnsafeArchiveError).reason).toBe('path-traversal');
  });

  it('a nested path that only looks odd (dots inside names, a leading ./) is kept', async () => {
    const archive = craftZip([stored('./docs/v1..2/file.txt', 'kept'), stored('a/...b/c', 'dots')]);
    const files = await extractZipArchive(archive);
    expect(files.map((f) => f.filename)).toEqual(['docs/v1..2/file.txt', 'a/...b/c']);
  });
});

describe('duplicate names are neither merged nor dropped', () => {
  const duplicates = (): Buffer => craftZip([stored('d.txt', 'first'), stored('keep.txt', 'k'), stored('d.txt', 'second')]);

  oracleTest(
    'both entries exist for 7-Zip, and the default policy keeps both under distinct names',
    ['7z'],
    async () => {
      const file = writeFixture('dup.zip', duplicates());
      const listing = execFileSync(getOracleToolPath('7z') as string, ['l', '-slt', '-ba', file], { encoding: 'utf8' });
      expect(listing.match(/^Path = d\.txt$/gm)).toHaveLength(2);
      const files = await extractZipArchive(duplicates());
      expect(files.map((f) => [f.filename, f.buffer.toString()])).toEqual([
        ['d.txt', 'first'],
        ['keep.txt', 'k'],
        ['d-1.txt', 'second'],
      ]);
    }
  );

  it("collisionPolicy 'error' answers 422 with the colliding name", async () => {
    const error = await rejection(() => extractZipArchive(duplicates(), { collisionPolicy: 'error' }));
    expect(error).toBeInstanceOf(ArchiveEntryCollisionError);
    expect(statusOf(error)).toBe(422);
    expect((error as ArchiveEntryCollisionError).entryName).toBe('d.txt');
  });

  it("collisionPolicy 'overwrite' keeps the last one, as requested", async () => {
    const files = await extractZipArchive(duplicates(), { collisionPolicy: 'overwrite' });
    expect(files.map((f) => [f.filename, f.buffer.toString()]).sort()).toEqual([['d.txt', 'second'], ['keep.txt', 'k']]);
  });

  it('names that collide only after separator and dot normalisation count as duplicates', async () => {
    const archive = craftZip([stored('a/b', 'one'), stored('a/./b', 'two'), stored('a\\b', 'three')]);
    const error = await rejection(() => extractZipArchive(archive, { collisionPolicy: 'error' }));
    expect(error).toBeInstanceOf(ArchiveEntryCollisionError);
    expect((error as ArchiveEntryCollisionError).entryName).toBe('a/b');
  });

  it('names that differ only in case are two entries, both kept', async () => {
    const files = await extractZipArchive(craftZip([stored('Case.txt', 'A'), stored('case.txt', 'B')]));
    expect(files.map((f) => [f.filename, f.buffer.toString()])).toEqual([['Case.txt', 'A'], ['case.txt', 'B']]);
  });
});

describe('symbolic links are not materialised as files', () => {
  oracleTest(
    'a zip -y archive is refused, or its link is left out and reported with skipLinks',
    ['zip', 'unzip'],
    async () => {
      const source = path.join(workDir, 'link-src');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'real.txt'), 'real');
      fs.symlinkSync('/etc/passwd', path.join(source, 'ln'));
      const archive = path.join(workDir, 'link.zip');
      execFileSync(getOracleToolPath('zip') as string, ['-q', '-y', archive, 'real.txt', 'ln'], { cwd: source });
      const zipinfo = execFileSync(getOracleToolPath('unzip') as string, ['-Z', archive], { encoding: 'utf8' });
      expect(zipinfo).toMatch(/^l[rwx-]{9}.* ln$/m);

      const bytes = fs.readFileSync(archive);
      const error = await rejection(() => extractZipArchive(bytes));
      expect(error).toBeInstanceOf(UnsafeArchiveError);
      expect((error as UnsafeArchiveError).reason).toBe('link-entry');

      let skipped: string[] = [];
      const files = await extractZipArchive(bytes, { skipLinks: true, onSkippedLinks: (names) => (skipped = names) });
      expect(files.map((f) => f.filename)).toEqual(['real.txt']);
      expect(skipped).toEqual(['ln']);
    }
  );

  it('a link flagged only in the attribute bits of a DOS-host entry is still a link', async () => {
    const archive = craftZip([stored('ln', '/etc/shadow', { versionMadeBy: 20, externalAttributes: (S_IFLNK | 0o777) * 0x10000 })]);
    const error = await rejection(() => extractZipArchive(archive));
    expect((error as UnsafeArchiveError).reason).toBe('link-entry');
  });
});

describe('the local headers and the central directory must agree', () => {
  const mismatches: Array<[string, CraftedEntry]> = [
    ['name', stored('shown.txt', 'x', { localName: 'hidden.txt' })],
    ['crc', stored('c.txt', 'crc', { localCrc: 0x12345678 })],
    ['compressed size', stored('s.txt', 'abcdef', { localCompressedSize: 3 })],
    ['uncompressed size', stored('u.txt', 'abcdef', { localUncompressedSize: 99 })],
  ];
  for (const [label, entry] of mismatches) {
    it(`a ${label} that differs is refused as malformed`, async () => {
      const error = await rejection(() => extractZipArchive(craftZip([entry])));
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect(statusOf(error)).toBe(400);
    });
  }

  it('a method that differs is refused as malformed', async () => {
    const layout = craftZipArchive([stored('m.txt', 'plain')]);
    const archive = Buffer.from(layout.archive);
    archive.writeUInt16LE(8, 8);
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/different compression method/);
  });

  it('a data-descriptor flag set in only one header is refused as malformed', async () => {
    const layout = craftZipArchive([stored('f.txt', 'flagged')]);
    const archive = Buffer.from(layout.archive);
    archive.writeUInt16LE(archive.readUInt16LE(layout.directoryOffset + 8) | 0x0008, layout.directoryOffset + 8);
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/different flags/);
  });

  it('a data descriptor archive reads its sizes from the central directory', async () => {
    const files = await extractZipArchive(craftZip([{ name: 'dd.txt', data: Buffer.from('descriptor '.repeat(100)), descriptor: true }]));
    expect(files[0].buffer.toString()).toBe('descriptor '.repeat(100));
  });

  it('a Unicode path field overrides the name only when its checksum matches the stored name', async () => {
    const legacy = Buffer.from('legacy.txt');
    const field = (name: string, nameCrc: number): Buffer => {
      const body = Buffer.concat([Buffer.from([1]), Buffer.alloc(4), Buffer.from(name)]);
      body.writeUInt32LE(nameCrc, 1);
      const header = Buffer.alloc(4);
      header.writeUInt16LE(0x7075, 0);
      header.writeUInt16LE(body.length, 2);
      return Buffer.concat([header, body]);
    };
    const crc = (bytes: Buffer): number => zlib.crc32(bytes);
    const good = craftZip([stored('x', 'a', { name: legacy, flags: 0, centralExtra: field('ünï.txt', crc(legacy)) })]);
    expect((await extractZipArchive(good))[0].filename).toBe('ünï.txt');
    const stale = craftZip([stored('x', 'a', { name: legacy, flags: 0, centralExtra: field('ünï.txt', 0xdeadbeef) })]);
    expect((await extractZipArchive(stale))[0].filename).toBe('legacy.txt');
    const traversing = craftZip([stored('x', 'a', { name: legacy, flags: 0, centralExtra: field('../evil', crc(legacy)) })]);
    expect(((await rejection(() => extractZipArchive(traversing))) as UnsafeArchiveError).reason).toBe('path-traversal');
  });
});

describe('entries that overlap are refused', () => {
  oracleTest(
    'central directory records that share one local header (a non-recursive bomb) are refused',
    ['unzip'],
    async () => {
      const layout = craftZipArchive([stored('one.bin', 'x'.repeat(2000)), stored('one.bin', 'y'.repeat(2000))]);
      const archive = Buffer.from(layout.archive);
      // Point the second record at the first entry's local header; every field it records still matches that header.
      const secondRecord = layout.directoryOffset + 46 + 'one.bin'.length;
      archive.writeUInt32LE(zipCrc32(Buffer.from('x'.repeat(2000))), secondRecord + 16);
      archive.writeUInt32LE(layout.offsets[0], secondRecord + 42);
      expect(unzipTest(writeFixture('shared-offset.zip', archive)).output).toMatch(/one\.bin/);
      const error = await rejection(() => extractZipArchive(archive));
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect((error as Error).message).toMatch(/overlap/i);
    }
  );

  it('one entry whose data runs into the next local header is refused', async () => {
    const layout = craftZipArchive([stored('a.bin', 'a'.repeat(100)), stored('b.bin', 'b'.repeat(100))]);
    const archive = Buffer.from(layout.archive);
    archive.writeUInt32LE(100 + 60, layout.directoryOffset + 20);
    archive.writeUInt32LE(100 + 60, layout.offsets[0] + 18);
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/overlap/i);
  });

  it('data that reaches past the central directory is refused', async () => {
    const error = await rejection(() => extractZipArchive(craftZip([stored('long.bin', 'z'.repeat(50), { compressedSize: 5000, uncompressedSize: 5000 })])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/runs past/);
  });
});

describe('ZIP64 fields that lie are refused', () => {
  const saturated = (extra: Buffer, over: Partial<CraftedEntry> = {}): Buffer =>
    craftZip([stored('big.bin', 'small', { compressedSize: 0xffffffff, uncompressedSize: 0xffffffff, centralExtra: extra, localExtra: extra, ...over })]);

  it('saturated sizes without a ZIP64 extra field are malformed', async () => {
    const error = await rejection(() => extractZipArchive(saturated(Buffer.alloc(0))));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/ZIP64 extra field is missing/);
  });

  it('a ZIP64 extra field too short for the saturated fields is malformed', async () => {
    const error = await rejection(() => extractZipArchive(saturated(zip64Extra({ uncompressed: 5n }))));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/ZIP64 extra field is too short/);
  });

  it('a ZIP64 size of a terabyte is a 413 before any bytes are read', async () => {
    const archive = saturated(zip64Extra({ uncompressed: 1n << 40n, compressed: 5n }));
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect(statusOf(error)).toBe(413);
  });

  const hugeEntry = (name: string): CraftedEntry =>
    stored(name, 'small', {
      compressedSize: 0xffffffff,
      uncompressedSize: 0xffffffff,
      centralExtra: zip64Extra({ uncompressed: 1n << 60n, compressed: 5n }),
      localExtra: zip64Extra({ uncompressed: 1n << 60n, compressed: 5n }),
    });

  for (const [label, names] of [['one entry', ['huge.bin']], ['several entries', ['h1.bin', 'h2.bin', 'h3.bin']]] as const) {
    it(`${label} declaring 2^60 bytes is a 413 that names the real limit`, async () => {
      const error = await rejection(() => extractZipArchive(craftZip(names.map(hugeEntry))));
      expect(error).toBeInstanceOf(DecompressionLimitError);
      expect(statusOf(error)).toBe(413);
      expect((error as Error).message).toMatch(/exceeds limit of 524288000 bytes/);
    });
  }

  it('a ZIP64 compressed size beyond the file is malformed', async () => {
    const archive = saturated(zip64Extra({ uncompressed: 5n, compressed: 1n << 40n }));
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/runs past/);
  });

  oracleTest(
    'an archive with a real ZIP64 end record is read, and one whose end record claims ZIP64 without it is not',
    ['unzip'],
    async () => {
      const layout = craftZipArchive([stored('z.txt', 'zip64 end record')], { zip64End: true });
      expect(unzipTest(writeFixture('z64-end.zip', layout.archive)).status).toBe(0);
      expect((await extractZipArchive(layout.archive))[0].buffer.toString()).toBe('zip64 end record');
      const withoutRecords = Buffer.concat([
        layout.archive.subarray(0, layout.directoryOffset + layout.directorySize),
        layout.archive.subarray(layout.archive.length - 22),
      ]);
      expect(await rejection(() => extractZipArchive(withoutRecords))).toBeInstanceOf(CorruptStreamError);
    }
  );

  it('an end record that counts more entries than the directory holds is malformed', async () => {
    const archive = craftZip([stored('only.txt', 'one')], { declaredEntries: 3000 });
    const error = await expectNoHangOnInput('lying entry count', (input: Buffer) => rejection(() => extractZipArchive(input)), archive);
    expect(error.largeResult).toBeInstanceOf(CorruptStreamError);
    expect((error.largeResult as Error).message).toMatch(/central directory does not fit/);
  });

  it('an end record that places the directory outside the file is malformed', async () => {
    const archive = craftZip([stored('only.txt', 'one')], { declaredDirectoryOffset: 0x7fffffff });
    expect(await rejection(() => extractZipArchive(archive))).toBeInstanceOf(CorruptStreamError);
    expect(((await rejection(() => extractZipArchive(archive))) as Error).message).toMatch(/central directory offset/);
  });
});

describe('a second end record hidden in the archive comment is ambiguous', () => {
  it('is refused, because two readers would list different entries', async () => {
    const decoy = Buffer.alloc(22);
    decoy.writeUInt32LE(0x06054b50, 0);
    decoy.writeUInt16LE(6, 20);
    const comment = Buffer.concat([decoy, Buffer.from('padded')]);
    const archive = craftZip([stored('real.txt', 'real entry')], { comment });
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/end of central directory/i);
  });
});

describe('an end record hidden whose comment stops short of the end of the file is ambiguous too', () => {
  const hiddenArchive = (): Buffer => {
    const inner = craftZip([stored('evil.txt', 'evil')]);
    return craftZip([stored('good.txt', 'good')], { comment: Buffer.concat([inner, Buffer.from('JUNK')]) });
  };

  oracleTest(
    'unzip lists the hidden archive while the real directory lists another file, so the reader refuses it',
    ['unzip'],
    async () => {
      const archive = hiddenArchive();
      // unzip warns about the extra bytes (exit 1) and lists the archive hidden in the comment.
      const listing = spawnSync(getOracleToolPath('unzip') as string, ['-Z1', writeFixture('hidden-loose.zip', archive)], { encoding: 'utf8' });
      expect(listing.stdout.trim()).toBe('evil.txt');
      const error = await rejection(() => extractZipArchive(archive));
      expect(error).toBeInstanceOf(CorruptStreamError);
      expect(statusOf(error)).toBe(400);
      expect((error as Error).message).toMatch(/more than one end of central directory record/);
    }
  );

  it('a stored ZIP inside the last entry is data, not a second archive', async () => {
    const nested = craftZip([stored('inner.txt', 'nested content')]);
    const outer = craftZip([stored('a.txt', 'first'), { name: 'inner.zip', data: nested, method: 0 }]);
    const files = await extractZipArchive(outer);
    expect(files.map((f) => f.filename)).toEqual(['a.txt', 'inner.zip']);
    expect(sha256(files[1].buffer)).toBe(sha256(nested));
  });

  it('trailing bytes after a single end record are tolerated', async () => {
    const files = await extractZipArchive(Buffer.concat([craftZip([stored('only.txt', 'one')]), Buffer.from('trailer')]));
    expect(files.map((f) => f.filename)).toEqual(['only.txt']);
  });
});

describe('the compression ratio counts once the output passes the small-entry baseline', () => {
  const repetitive = (bytes: number): Buffer => craftZip([{ name: 'text.txt', data: Buffer.alloc(bytes, 0x61) }]);

  oracleTest(
    'a 64 KiB text entry in a few hundred bytes is read, as unzip and 7z read it',
    ['unzip', '7z'],
    async () => {
      const archive = repetitive(64 * 1024);
      expect(archive.length).toBeLessThan(300);
      const file = writeFixture('small-ratio.zip', archive);
      expect(unzipTest(file).status).toBe(0);
      expect(sevenZipTest(file)).toBe(0);
      const files = await extractZipArchive(archive);
      expect(files[0].buffer.length).toBe(64 * 1024);
      expect(files[0].buffer.every((byte) => byte === 0x61)).toBe(true);
      const tar = await convertArchive(archive, 'zip', 'tar', {}, 'small-ratio.zip');
      expect(tar.size).toBeGreaterThan(64 * 1024);
    }
  );

  it('the same repetition past the baseline is a 413 naming the ratio', async () => {
    const error = await rejection(() => extractZipArchive(repetitive(4 * MIB)));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect(statusOf(error)).toBe(413);
    expect((error as Error).message).toMatch(/compression ratio \(\d+\.\d:1\) exceeds 100:1/);
  });
});

describe('sizes and checksums are checked against what the stream decodes to', () => {
  it('an entry that decodes to more than it declares stops early', async () => {
    const zeros = Buffer.alloc(300 * MIB);
    const payload = zlib.deflateRawSync(zeros, { level: 9 });
    const archive = craftZip([{ name: 'lie.bin', data: Buffer.from('tiny'), rawPayload: payload, method: 8, uncompressedSize: 4, crc: 0 }]);
    const result = await expectNoHangOnInput('declared 4 bytes, stream holds 300 MiB', (input: Buffer) => rejection(() => extractZipArchive(input)), archive);
    expect(result.largeResult).toBeInstanceOf(CorruptStreamError);
    expect((result.largeResult as Error).message).toMatch(/more than the 4 bytes it declares/);
  }, TIMEOUT_MS);

  it('an entry that decodes to less than it declares is malformed', async () => {
    const data = Buffer.from('short');
    const error = await rejection(() => extractZipArchive(craftZip([{ name: 's.bin', data, uncompressedSize: 500 }])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/decodes to 5 bytes but declares 500/);
  });

  it('a wrong CRC-32 is malformed', async () => {
    const error = await rejection(() => extractZipArchive(craftZip([{ name: 'bad.bin', data: Buffer.from('crc matters'), crc: 0x0badc0de }])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/CRC/i);
  });

  it('a stored entry whose two sizes disagree is malformed', async () => {
    const error = await rejection(() => extractZipArchive(craftZip([stored('st.bin', 'abcdef', { uncompressedSize: 3 })])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/stored but its compressed size 6 differs from its uncompressed size 3/);
  });

  it('a damaged deflate stream is malformed, not an internal error', async () => {
    const error = await rejection(() => extractZipArchive(craftZip([{ name: 'bad.deflate', data: Buffer.from('x'), rawPayload: Buffer.from([0xff, 0xff, 0xff, 0xff]), uncompressedSize: 8 }])));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect((error as Error).message).toMatch(/not a valid deflate stream/);
  });
});

describe('methods and encryption are answered with typed errors', () => {
  for (const [label, method] of [['bzip2', 12], ['LZMA', 14], ['PPMd', 98]] as const) {
    it(`${label} entries answer 422 (known method, not decoded here)`, async () => {
      const error = await rejection(() => extractZipArchive(craftZip([stored('m.bin', 'payload', { method })])));
      expect(error).toBeInstanceOf(UnsupportedArchiveMethodError);
      expect(statusOf(error)).toBe(422);
    });
  }

  it('an entry flagged encrypted in the central directory answers 422 asking for a password', async () => {
    const archive = craftZip([stored('secret.txt', 'cipher', { flags: ZIP_FLAG_UTF8 | ZIP_FLAG_ENCRYPTED })]);
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(ArchivePasswordRequiredError);
    expect(error).toBeInstanceOf(ArchiveInputUnprocessableError);
    expect(statusOf(error)).toBe(422);
  });
});

describe('limits answer 413 and stop early', () => {
  it('more entries than the cap are refused without decoding any', async () => {
    const entries: CraftedEntry[] = [];
    for (let i = 0; i < 50_001; i++) entries.push({ name: `e${i}`, data: Buffer.alloc(0), method: 0 });
    const archive = craftZip(entries);
    const result = await expectNoHangOnInput('50001 entries', (input: Buffer) => rejection(() => extractZipArchive(input)), archive);
    expect(result.largeResult).toBeInstanceOf(DecompressionLimitError);
    expect(statusOf(result.largeResult)).toBe(413);
  }, TIMEOUT_MS);

  it('an entry declaring more than the byte cap is refused from the header', async () => {
    const archive = craftZip([stored('huge.bin', 'x', { uncompressedSize: 600 * MIB })]);
    const error = await rejection(() => extractZipArchive(archive));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect(statusOf(error)).toBe(413);
  });

  oracleTest(
    'a 600 MB run of zeros made by zip(1) is a 413 through the conversion entry point',
    ['zip', 'unzip'],
    async () => {
      const source = path.join(workDir, 'zeros.bin');
      execFileSync('head', ['-c', String(600 * MIB), '/dev/zero'], { stdio: ['ignore', fs.openSync(source, 'w'), 'inherit'] });
      const archive = path.join(workDir, 'zeros.zip');
      execFileSync(getOracleToolPath('zip') as string, ['-q', '-9', archive, 'zeros.bin'], { cwd: workDir });
      fs.rmSync(source);
      expect(unzipTest(archive).status).toBe(0);
      const bytes = fs.readFileSync(archive);
      const result = await expectNoHangOnInput(
        'zero bomb',
        (input: Buffer) => rejection(() => convertArchive(input, 'zip', 'tar', {}, 'zeros.zip')),
        bytes
      );
      expect(result.largeResult).toBeInstanceOf(DecompressionLimitError);
      expect(statusOf(result.largeResult)).toBe(413);
      expect(result.largeResult).toBeInstanceOf(ConversionFailedError);
    },
    TIMEOUT_MS
  );
});
