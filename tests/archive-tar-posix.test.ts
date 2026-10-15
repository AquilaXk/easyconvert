import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTarEntryHeaders,
  createTarArchive,
  extractTarArchive,
  readTarEntries,
} from '../src/lib/conversions/archive';
import { ConversionFailedError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * POSIX pax/ustar (IEEE 1003.1) conformance for the native TAR writer and reader.
 *
 * Independent oracles: GNU tar (required; the test fails under ORACLE_STRICT_MODE=1 when it is
 * missing) and bsdtar (optional; skipped explicitly because CI does not install libarchive-tools).
 * Header bytes that the oracle cannot show are decoded by the small parser in this file, which does
 * not share any code with the module under test.
 */

const BLOCK = 512;
const UTF8_ENV = { ...process.env, LC_ALL: 'C.UTF-8' };
const KOREAN_NAME = '한글-문서-테스트.txt';
const EMOJI_NAME = 'party-🎉-rocket-🚀.txt';
const LONG_ASCII_NAME = `${'x'.repeat(146)}.txt`; // 150 chars, single segment
const SPLIT_DIR = `${'d'.repeat(60)}/${'e'.repeat(60)}`; // 121 bytes of directory
const SPLIT_PATH = `${SPLIT_DIR}/${'f'.repeat(50)}.txt`; // 176 bytes: needs the ustar prefix field
const FIXED_MTIME = new Date('2021-03-04T05:06:07Z');
const FIXED_MTIME_SECONDS = 1614834367;

const bsdtarProbe = spawnSync('bsdtar', ['--version'], { encoding: 'utf8' });
const BSDTAR_AVAILABLE = bsdtarProbe.status === 0 && /bsdtar/.test(bsdtarProbe.stdout);

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-tar-posix-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function gnuTar(): string {
  const tool = getOracleToolPath('tar');
  if (!tool) throw new Error('GNU tar is required for this oracle test');
  return tool;
}

function run(bin: string, args: string[], options: { input?: Buffer; cwd?: string } = {}) {
  const res = spawnSync(bin, args, {
    input: options.input,
    cwd: options.cwd,
    env: UTF8_ENV,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr.toString('utf8') };
}

/** Independent unsigned header checksum (chksum field counted as eight spaces). */
function checksumOf(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function sealHeader(header: Buffer): Buffer {
  header.write(`${checksumOf(header).toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

interface CraftedHeader {
  name: string;
  typeflag: string;
  size?: number;
  sizeField?: Buffer;
  linkname?: string;
}

/** Hand-assembles one ustar header block (independent of the module under test). */
function craftHeader(spec: CraftedHeader): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(spec.name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  if (spec.sizeField) {
    spec.sizeField.copy(header, 124);
  } else {
    header.write(`${(spec.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  }
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(spec.typeflag, 156, 1, 'ascii');
  if (spec.linkname) header.write(spec.linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  return sealHeader(header);
}

function padTo(data: Buffer): Buffer {
  const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

const END_OF_ARCHIVE = Buffer.alloc(BLOCK * 2);

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf8');
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, 'utf8');
}

/** Minimal independent pax record decoder: "<len> <key>=<value>\n". */
function decodePax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const len = Number(data.toString('ascii', pos, space));
    expect(data[pos + len - 1]).toBe(0x0a);
    const record = data.toString('utf8', space + 1, pos + len - 1);
    const eq = record.indexOf('=');
    out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

function typeflagOf(archive: Buffer, blockIndex: number): string {
  return String.fromCharCode(archive[blockIndex * BLOCK + 156]);
}

function listWithTool(bin: string, archive: Buffer): string[] {
  const args = bin === 'bsdtar' ? ['-tf', '-'] : ['--quoting-style=literal', '-tf', '-'];
  const res = run(bin, args, { input: archive });
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  return res.stdout.toString('utf8').split('\n').filter(Boolean);
}

function extractWithTool(bin: string, archive: Buffer): string {
  const dir = makeTempDir();
  const res = run(bin, ['-xf', '-'], { input: archive, cwd: dir });
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  return dir;
}

function walkFiles(root: string, rel = ''): Record<string, Buffer> {
  const found: Record<string, Buffer> = {};
  for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
    const relPath = rel ? `${rel}/${name}` : name;
    const stat = fs.lstatSync(path.join(root, relPath));
    if (stat.isDirectory()) Object.assign(found, walkFiles(root, relPath));
    else if (stat.isFile()) found[relPath] = fs.readFileSync(path.join(root, relPath));
  }
  return found;
}

const WRITER_FILES = [
  { filename: 'plain.txt', buffer: Buffer.from('plain content\n') },
  { filename: LONG_ASCII_NAME, buffer: Buffer.from('150-character ascii name payload') },
  { filename: KOREAN_NAME, buffer: Buffer.from('한글 본문 내용입니다\n') },
  { filename: EMOJI_NAME, buffer: Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x0a, 0x0d]) },
  { filename: SPLIT_PATH, buffer: Buffer.from('needs ustar prefix') },
  { filename: `deep/${KOREAN_NAME}`, buffer: Buffer.alloc(1500, 0xab) },
  { filename: 'empty.bin', buffer: Buffer.alloc(0) },
];

function writerOracleSuite(label: string, resolveBin: () => string, wrap: typeof oracleTest | null) {
  const register = (name: string, fn: () => void | Promise<void>) => {
    if (wrap) wrap(name, ['tar'], fn);
    // skip-ok: bsdtar is a second, optional reference reader that CI does not install; the GNU tar run of this suite makes the same assertions.
    else it.skipIf(!BSDTAR_AVAILABLE)(name, fn);
  };

  describe(`writer output read by ${label}`, () => {
    register('lists every name (150-char ASCII, Korean, emoji, ustar prefix split) unchanged', () => {
      const archive = createTarArchive(WRITER_FILES, {}, 'x.tar', { defaultMtime: FIXED_MTIME }).buffer;
      const names = listWithTool(resolveBin(), archive);
      expect(names).toEqual(WRITER_FILES.map((f) => f.filename));
      expect(LONG_ASCII_NAME).toHaveLength(150);
    });

    register('extracts every file byte-for-byte under its full UTF-8 path', () => {
      const archive = createTarArchive(WRITER_FILES, {}, 'x.tar', { defaultMtime: FIXED_MTIME }).buffer;
      const dir = extractWithTool(resolveBin(), archive);
      const onDisk = walkFiles(dir);
      expect(Object.keys(onDisk).sort()).toEqual(WRITER_FILES.map((f) => f.filename).sort());
      for (const f of WRITER_FILES) {
        expect(onDisk[f.filename].equals(f.buffer)).toBe(true);
      }
    });

    register('emits directory entries with typeflag 5 that extract as directories', () => {
      const archive = createTarArchive(
        [
          { filename: 'folder/', buffer: Buffer.alloc(0) },
          { filename: 'folder/inner.txt', buffer: Buffer.from('inner') },
        ],
        {},
        'x.tar',
        { defaultMtime: FIXED_MTIME }
      ).buffer;
      expect(typeflagOf(archive, 0)).toBe('5');
      const dir = extractWithTool(resolveBin(), archive);
      expect(fs.statSync(path.join(dir, 'folder')).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'folder', 'inner.txt'), 'utf8')).toBe('inner');
    });
  });
}

describe('TAR writer: POSIX header layout', () => {
  it('keeps names that fit in the ustar name/prefix split without a pax header', () => {
    const archive = createTarArchive(
      [{ filename: SPLIT_PATH, buffer: Buffer.from('x') }],
      {},
      'x.tar',
      { defaultMtime: FIXED_MTIME }
    ).buffer;

    // header + one data block + two end-of-archive blocks, no 'x' extension header
    expect(archive).toHaveLength(BLOCK * 4);
    expect(typeflagOf(archive, 0)).toBe('0');
    const prefix = archive.toString('utf8', 345, 345 + 155).replace(/\0.*$/, '');
    const name = archive.toString('utf8', 0, 100).replace(/\0.*$/, '');
    expect(`${prefix}/${name}`).toBe(SPLIT_PATH);
    expect(prefix.length).toBeLessThanOrEqual(155);
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it('writes a PAX x header with UTF-8 path records for long and non-ASCII names', () => {
    for (const filename of [LONG_ASCII_NAME, KOREAN_NAME, EMOJI_NAME]) {
      const archive = createTarArchive(
        [{ filename, buffer: Buffer.from('payload') }],
        {},
        'x.tar',
        { defaultMtime: FIXED_MTIME }
      ).buffer;
      expect(typeflagOf(archive, 0)).toBe('x');
      const paxSize = parseInt(archive.toString('ascii', 124, 135), 8);
      const records = decodePax(archive.subarray(BLOCK, BLOCK + paxSize));
      expect(records.path).toBe(filename);
      // the real entry follows the (padded) pax data block
      const entryBlock = 1 + Math.ceil(paxSize / BLOCK);
      expect(typeflagOf(archive, entryBlock)).toBe('0');
    }
  });

  it('fills ustar magic, version, mode, uid/gid and a valid unsigned checksum', () => {
    const archive = createTarArchive(
      [{ filename: 'a.txt', buffer: Buffer.from('abc') }],
      {},
      'x.tar',
      { defaultMtime: FIXED_MTIME }
    ).buffer;
    const header = archive.subarray(0, BLOCK);
    expect(header.toString('latin1', 257, 263)).toBe('ustar\0');
    expect(header.toString('latin1', 263, 265)).toBe('00');
    expect(header.toString('latin1', 100, 108)).toBe('0000644\0');
    expect(header.toString('latin1', 108, 116)).toBe('0000000\0');
    expect(header.toString('latin1', 116, 124)).toBe('0000000\0');
    expect(parseInt(header.toString('ascii', 124, 135), 8)).toBe(3);
    const stored = parseInt(header.toString('ascii', 148, 154), 8);
    expect(stored).toBe(checksumOf(header));
    expect(header.toString('latin1', 154, 156)).toBe('\0 ');
  });

  it('is deterministic and never reads the wall clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const first = createTarArchive(WRITER_FILES).buffer;
    vi.setSystemTime(new Date('2031-06-06T06:06:06Z'));
    const second = createTarArchive(WRITER_FILES).buffer;
    expect(second.equals(first)).toBe(true);
    // default mtime is a fixed constant, not 2030
    const mtime = parseInt(first.toString('ascii', 136, 147), 8);
    expect(mtime).toBeLessThan(FIXED_MTIME_SECONDS);
  });

  it('takes mtime and mode from the input file metadata', () => {
    const archive = createTarArchive(
      [{ filename: 'meta.sh', buffer: Buffer.from('#!/bin/sh\n'), mtime: FIXED_MTIME, mode: 0o755 }],
      {}
    ).buffer;
    expect(parseInt(archive.toString('ascii', 136, 147), 8)).toBe(FIXED_MTIME_SECONDS);
    expect(archive.toString('latin1', 100, 108)).toBe('0000755\0');
  });

  oracleTest('GNU tar prints the recorded mtime and the permission bits', ['tar'], () => {
    const archive = createTarArchive(
      [{ filename: 'meta.sh', buffer: Buffer.from('#!/bin/sh\n'), mtime: FIXED_MTIME, mode: 0o755 }],
      {}
    ).buffer;
    const res = run(gnuTar(), ['-tvf', '-', '--utc'], { input: archive });
    expect(res.status).toBe(0);
    expect(res.stdout.toString('utf8')).toMatch(/^-rwxr-xr-x 0\/0\s+10 2021-03-04 05:06 meta\.sh$/m);
  });

  it('encodes sizes of 8 GiB and above in a PAX size record', () => {
    const size = 9 * 1024 * 1024 * 1024 + 123;
    const headers = buildTarEntryHeaders({ filename: 'huge.bin', size, mtime: FIXED_MTIME });
    expect(typeflagOf(headers, 0)).toBe('x');
    const paxSize = parseInt(headers.toString('ascii', 124, 135), 8);
    const records = decodePax(headers.subarray(BLOCK, BLOCK + paxSize));
    expect(records.size).toBe(String(size));
    // ustar size field cannot hold the value: it carries the largest octal number instead
    const entryHeader = headers.subarray(headers.length - BLOCK);
    expect(entryHeader.toString('ascii', 124, 136)).toBe('77777777777\0');
    expect(parseInt(entryHeader.toString('ascii', 148, 154), 8)).toBe(checksumOf(entryHeader));
  });

  oracleTest('GNU tar reads the PAX size record of an oversized entry', ['tar'], () => {
    const size = 9 * 1024 * 1024 * 1024 + 123;
    const headers = buildTarEntryHeaders({ filename: 'huge.bin', size, mtime: FIXED_MTIME });
    // body intentionally absent: tar must still report the entry with the pax size before EOF
    const res = run(gnuTar(), ['-tvf', '-'], { input: headers });
    expect(res.stdout.toString('utf8')).toContain(`${size} `);
    expect(res.stdout.toString('utf8')).toContain('huge.bin');
  });

  it('rejects an unusable entry name with a typed error', () => {
    expect(() => createTarArchive([{ filename: '', buffer: Buffer.alloc(0) }])).toThrow(
      ConversionFailedError
    );
    expect(() => createTarArchive([{ filename: 'bad\0name', buffer: Buffer.alloc(1) }])).toThrow(
      ConversionFailedError
    );
  });
});

writerOracleSuite('GNU tar', gnuTar, oracleTest);
writerOracleSuite('bsdtar', () => 'bsdtar', null);

interface SourceTree {
  root: string;
  files: Record<string, Buffer>;
  longTarget: string;
}

/** Populates a directory with files, a directory, a symlink and a hardlink for the oracle to archive. */
function buildSourceTree(maxPathBytes: 'any' | 'ustar'): SourceTree {
  const root = makeTempDir();
  const files: Record<string, Buffer> = {
    'plain.txt': Buffer.from('plain\n'),
    [KOREAN_NAME]: Buffer.from('한글 내용\n'),
    [EMOJI_NAME]: Buffer.from([1, 2, 3, 0, 255]),
    [`${SPLIT_DIR}/${'g'.repeat(40)}.txt`]: Buffer.from('prefix split\n'),
  };
  if (maxPathBytes === 'any') {
    files[LONG_ASCII_NAME] = Buffer.from('long name body');
  }
  for (const [rel, data] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
  }
  fs.mkdirSync(path.join(root, 'emptydir'));
  fs.symlinkSync('plain.txt', path.join(root, 'link-to-plain'));
  fs.linkSync(path.join(root, 'plain.txt'), path.join(root, 'hard-to-plain'));
  const longTarget = `${'t'.repeat(130)}.txt`;
  if (maxPathBytes === 'any') {
    fs.symlinkSync(longTarget, path.join(root, 'long-link'));
  }
  return { root, files, longTarget };
}

function archiveTree(bin: string, formatArgs: string[], tree: SourceTree): Buffer {
  const names = fs
    .readdirSync(tree.root)
    .sort()
    .filter((n) => n !== 'out.tar');
  const out = path.join(makeTempDir(), 'out.tar');
  const res = run(bin, [...formatArgs, '--sort=name', '-cf', out, '-C', tree.root, ...names]);
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  return fs.readFileSync(out);
}

function expectTreeEntries(entries: ReturnType<typeof readTarEntries>, tree: SourceTree, withLongLink: boolean) {
  const byName = new Map(entries.map((e) => [e.filename, e]));
  for (const [rel, data] of Object.entries(tree.files)) {
    const entry = byName.get(rel);
    expect(entry, `missing ${rel}`).toBeTruthy();
    // plain.txt is stored as a hardlink when its twin sorts first, so its type is checked below
    if (rel !== 'plain.txt') {
      expect(entry!.type).toBe('file');
      expect(entry!.buffer.equals(data)).toBe(true);
    }
  }
  expect(byName.get('emptydir')!.type).toBe('directory');
  expect(byName.get('emptydir')!.buffer).toHaveLength(0);
  const symlink = byName.get('link-to-plain')!;
  expect(symlink.type).toBe('symlink');
  expect(symlink.linkTarget).toBe('plain.txt');
  // GNU tar stores whichever of the two hard-linked names it meets second as a link entry
  const types = new Set([byName.get('plain.txt')!.type, byName.get('hard-to-plain')!.type]);
  expect(types).toEqual(new Set(['file', 'hardlink']));
  if (withLongLink) {
    expect(byName.get('long-link')!.linkTarget).toBe(tree.longTarget);
  }
}

describe('TAR reader: archives produced by GNU tar', () => {
  for (const format of ['pax', 'gnu', 'ustar', 'v7'] as const) {
    oracleTest(`reads --format=${format} names, typeflags, link targets and contents`, ['tar'], () => {
      const wide = format === 'pax' || format === 'gnu';
      const tree = buildSourceTree(wide ? 'any' : 'ustar');
      if (format === 'v7') {
        // v7 has no prefix field and no UTF-8 guarantee beyond 100 bytes: drop the split path
        fs.rmSync(path.join(tree.root, SPLIT_DIR.split('/')[0]), { recursive: true });
        for (const key of Object.keys(tree.files)) {
          if (key.startsWith(SPLIT_DIR)) delete tree.files[key];
        }
      }
      const archive = archiveTree(gnuTar(), [`--format=${format}`], tree);
      const entries = readTarEntries(archive);
      expectTreeEntries(entries, tree, wide);
    });
  }

  oracleTest('extractTarArchive returns regular files and resolves hardlinks to their content', ['tar'], () => {
    const tree = buildSourceTree('any');
    const archive = archiveTree(gnuTar(), ['--format=pax'], tree);
    const files = extractTarArchive(archive);
    const byName = new Map(files.map((f) => [f.filename, f.buffer]));
    for (const [rel, data] of Object.entries(tree.files)) {
      expect(byName.get(rel)!.equals(data)).toBe(true);
    }
    expect(byName.get('hard-to-plain')!.toString('utf8')).toBe('plain\n');
    expect(byName.has('link-to-plain')).toBe(false);
    expect(byName.has('emptydir')).toBe(false);
  });

  oracleTest('reads base-256 uid and negative mtime written by GNU tar', ['tar'], () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, 'a'), 'hi');
    const out = path.join(makeTempDir(), 'x.tar');
    const res = run(gnuTar(), ['--format=gnu', '--owner=bob:3000000000', '--mtime=@-1000', '-cf', out, '-C', root, 'a']);
    expect(res.status).toBe(0);
    const archive = fs.readFileSync(out);
    expect(archive[108] & 0x80).toBe(0x80); // oracle sanity: field really is base-256
    const [entry] = readTarEntries(archive);
    expect(entry.uid).toBe(3000000000);
    expect(entry.mtime).toBe(-1000);
  });

  oracleTest('stops at the first two zero blocks like GNU tar', ['tar'], () => {
    const tree = buildSourceTree('ustar');
    const first = archiveTree(gnuTar(), ['--format=ustar'], tree);
    const second = createTarArchive([{ filename: 'second-archive-only.txt', buffer: Buffer.from('x') }]).buffer;
    const concatenated = Buffer.concat([first, second]);
    const toolNames = listWithTool(gnuTar(), concatenated);
    const ourNames = readTarEntries(concatenated).map((e) => e.filename);
    expect(ourNames).not.toContain('second-archive-only.txt');
    expect(ourNames.sort()).toEqual(toolNames.map((n) => n.replace(/\/$/, '')).sort());
  });

  oracleTest('rejects a corrupted checksum byte as GNU tar does', ['tar'], () => {
    const tree = buildSourceTree('ustar');
    const archive = archiveTree(gnuTar(), ['--format=ustar'], tree);
    for (const position of [148, 150, 152]) {
      const corrupted = Buffer.from(archive);
      corrupted[position] = corrupted[position] === 0x37 ? 0x36 : 0x37;
      expect(run(gnuTar(), ['-tf', '-'], { input: corrupted }).status).not.toBe(0);
      expect(() => readTarEntries(corrupted)).toThrow(ConversionFailedError);
      expect(() => readTarEntries(corrupted)).toThrow(/checksum/i);
      expect(() => extractTarArchive(corrupted)).toThrow(ConversionFailedError);
    }
  });

  oracleTest('rejects a header byte that no longer matches its checksum', ['tar'], () => {
    const archive = createTarArchive([{ filename: 'a.txt', buffer: Buffer.from('abc') }]).buffer;
    const corrupted = Buffer.from(archive);
    corrupted[0] ^= 0x01; // flip one bit of the name
    expect(run(gnuTar(), ['-tf', '-'], { input: corrupted }).status).not.toBe(0);
    expect(() => extractTarArchive(corrupted)).toThrow(/checksum/i);
  });

  oracleTest('throws a typed error for a truncated body like GNU tar does', ['tar'], () => {
    const archive = createTarArchive([{ filename: 'big.bin', buffer: Buffer.alloc(3000, 0x41) }]).buffer;
    const truncated = archive.subarray(0, BLOCK + 1000);
    expect(run(gnuTar(), ['-tf', '-'], { input: truncated }).status).not.toBe(0);
    expect(() => extractTarArchive(truncated)).toThrow(ConversionFailedError);
    expect(() => extractTarArchive(truncated)).toThrow(/truncat/i);
  });

  oracleTest('reads a base-256 size field the same way GNU tar does', ['tar'], () => {
    const sizeField = Buffer.alloc(12);
    sizeField[0] = 0x80;
    sizeField.writeUInt32BE(11, 8);
    const body = Buffer.from('hello world');
    const archive = Buffer.concat([
      craftHeader({ name: 'b256.txt', typeflag: '0', sizeField }),
      padTo(body),
      END_OF_ARCHIVE,
    ]);
    const toolOut = run(gnuTar(), ['-xOf', '-'], { input: archive });
    expect(toolOut.status).toBe(0);
    expect(toolOut.stdout.toString('utf8')).toBe('hello world');
    const [entry] = readTarEntries(archive);
    expect(entry.buffer.toString('utf8')).toBe('hello world');
  });

  oracleTest('applies a PAX size record over the ustar size field', ['tar'], () => {
    const body = Buffer.from('twelve bytes');
    const pax = paxRecord('size', String(body.length));
    const archive = Buffer.concat([
      craftHeader({ name: 'PaxHeaders/x', typeflag: 'x', size: pax.length }),
      padTo(pax),
      craftHeader({ name: 'sized.txt', typeflag: '0', size: 0 }),
      padTo(body),
      END_OF_ARCHIVE,
    ]);
    const toolOut = run(gnuTar(), ['-xOf', '-'], { input: archive });
    expect(toolOut.stdout.toString('utf8')).toBe('twelve bytes');
    const [entry] = readTarEntries(archive);
    expect(entry.filename).toBe('sized.txt');
    expect(entry.buffer.toString('utf8')).toBe('twelve bytes');
  });

  oracleTest('applies a PAX global header to following entries and a local one only once', ['tar'], () => {
    const global = paxRecord('path', 'ignored-by-local-override.txt');
    const local = paxRecord('path', `${KOREAN_NAME}`);
    const archive = Buffer.concat([
      craftHeader({ name: 'GlobalHead', typeflag: 'g', size: global.length }),
      padTo(global),
      craftHeader({ name: 'PaxHeaders/x', typeflag: 'x', size: local.length }),
      padTo(local),
      craftHeader({ name: 'first', typeflag: '0', size: 1 }),
      padTo(Buffer.from('1')),
      // no local header: this second entry must receive the global path record
      craftHeader({ name: 'second', typeflag: '0', size: 1 }),
      padTo(Buffer.from('2')),
      END_OF_ARCHIVE,
    ]);
    const expected = [KOREAN_NAME, 'ignored-by-local-override.txt'];
    const listed = run(gnuTar(), ['--quoting-style=literal', '-tf', '-'], { input: archive }).stdout.toString('utf8');
    expect(listed.split('\n').filter(Boolean)).toEqual(expected);
    expect(readTarEntries(archive).map((e) => e.filename)).toEqual(expected);
  });

  it('honours GNU long name (L) and long link (K) records', () => {
    const longName = `${'n'.repeat(180)}.txt`;
    const longLink = `${'k'.repeat(170)}.txt`;
    const nameData = Buffer.from(`${longName}\0`);
    const linkData = Buffer.from(`${longLink}\0`);
    const archive = Buffer.concat([
      craftHeader({ name: '././@LongLink', typeflag: 'L', size: nameData.length }),
      padTo(nameData),
      craftHeader({ name: '././@LongLink', typeflag: 'K', size: linkData.length }),
      padTo(linkData),
      craftHeader({ name: 'short', typeflag: '2', linkname: 'short' }),
      END_OF_ARCHIVE,
    ]);
    const [entry] = readTarEntries(archive);
    expect(entry.filename).toBe(longName);
    expect(entry.type).toBe('symlink');
    expect(entry.linkTarget).toBe(longLink);
  });
});

describe('TAR reader: typeflag policy and link containment', () => {
  oracleTest('rejects a symlink that escapes the extraction root (GNU-created)', ['tar'], () => {
    const root = makeTempDir();
    fs.symlinkSync('../../etc/passwd', path.join(root, 'escape'));
    const out = path.join(makeTempDir(), 'x.tar');
    expect(run(gnuTar(), ['--format=ustar', '-cf', out, '-C', root, 'escape']).status).toBe(0);
    const archive = fs.readFileSync(out);
    expect(() => readTarEntries(archive)).toThrow(ConversionFailedError);
    expect(() => readTarEntries(archive)).toThrow(/escape|outside/i);
  });

  oracleTest('accepts a symlink that stays inside the root even when it climbs and returns', ['tar'], () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a/target.txt'), 't');
    fs.symlinkSync('../target.txt', path.join(root, 'a/b/inside'));
    const out = path.join(makeTempDir(), 'x.tar');
    expect(run(gnuTar(), ['--format=pax', '-cf', out, '-C', root, 'a']).status).toBe(0);
    const inside = readTarEntries(fs.readFileSync(out)).find((e) => e.filename === 'a/b/inside')!;
    expect(inside.type).toBe('symlink');
    expect(inside.linkTarget).toBe('../target.txt');
  });

  it('rejects absolute symlink targets and hardlink targets that leave the root', () => {
    const cases: CraftedHeader[] = [
      { name: 'abs', typeflag: '2', linkname: '/etc/passwd' },
      { name: 'dir/up', typeflag: '2', linkname: '../../outside' },
      { name: 'hard', typeflag: '1', linkname: '../outside.txt' },
      { name: 'hard-abs', typeflag: '1', linkname: '/etc/shadow' },
    ];
    for (const spec of cases) {
      const archive = Buffer.concat([craftHeader(spec), END_OF_ARCHIVE]);
      expect(() => readTarEntries(archive), spec.name).toThrow(ConversionFailedError);
    }
  });

  it('fails extraction when a hardlink target is not an earlier file entry', () => {
    const archive = Buffer.concat([
      craftHeader({ name: 'orphan', typeflag: '1', linkname: 'missing.txt' }),
      END_OF_ARCHIVE,
    ]);
    expect(() => extractTarArchive(archive)).toThrow(ConversionFailedError);
  });

  it('treats typeflag 7 as a regular file and skips vendor-extension typeflags', () => {
    const vendorBody = Buffer.from('vendor');
    const archive = Buffer.concat([
      craftHeader({ name: 'contiguous.txt', typeflag: '7', size: 3 }),
      padTo(Buffer.from('abc')),
      craftHeader({ name: 'vendor-entry', typeflag: 'Z', size: vendorBody.length }),
      padTo(vendorBody),
      craftHeader({ name: 'after.txt', typeflag: '0', size: 2 }),
      padTo(Buffer.from('ok')),
      END_OF_ARCHIVE,
    ]);
    const entries = readTarEntries(archive);
    expect(entries.map((e) => [e.filename, e.buffer.toString('utf8')])).toEqual([
      ['contiguous.txt', 'abc'],
      ['after.txt', 'ok'],
    ]);
  });

  it('throws for typeflags that are neither defined nor vendor extensions', () => {
    for (const typeflag of ['9', 'q', 'S', 'M']) {
      const archive = Buffer.concat([craftHeader({ name: 'odd', typeflag }), END_OF_ARCHIVE]);
      expect(() => readTarEntries(archive), typeflag).toThrow(ConversionFailedError);
    }
  });

  it('throws when an extension header has no entry after it', () => {
    const pax = paxRecord('path', 'dangling.txt');
    const archive = Buffer.concat([
      craftHeader({ name: 'PaxHeaders/x', typeflag: 'x', size: pax.length }),
      padTo(pax),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(ConversionFailedError);
  });

  it('throws on malformed PAX record lengths', () => {
    const bad = Buffer.from('99 path=short\n');
    const archive = Buffer.concat([
      craftHeader({ name: 'PaxHeaders/x', typeflag: 'x', size: bad.length }),
      padTo(bad),
      craftHeader({ name: 'file', typeflag: '0', size: 0 }),
      END_OF_ARCHIVE,
    ]);
    expect(() => readTarEntries(archive)).toThrow(ConversionFailedError);
  });

  it('round-trips the module output through its own reader without losing names or bytes', () => {
    const archive = createTarArchive(
      [...WRITER_FILES, { filename: 'folder/', buffer: Buffer.alloc(0) }],
      {},
      'x.tar',
      { defaultMtime: FIXED_MTIME }
    ).buffer;
    const entries = readTarEntries(archive);
    const files = entries.filter((e) => e.type === 'file');
    expect(files.map((f) => f.filename)).toEqual(WRITER_FILES.map((f) => f.filename));
    files.forEach((f, i) => expect(f.buffer.equals(WRITER_FILES[i].buffer)).toBe(true));
    expect(entries.find((e) => e.filename === 'folder')!.type).toBe('directory');
  });
});

describe('TAR reader: bsdtar', () => {
  for (const format of ['pax', 'ustar', 'gnutar']) {
    // skip-ok: bsdtar is a second, optional reference writer that CI does not install; the GNU tar suite above reads archives written by GNU tar.
    it.skipIf(!BSDTAR_AVAILABLE)(`reads --format=${format} archives written by bsdtar`, () => {
      const tree = buildSourceTree(format === 'ustar' ? 'ustar' : 'any');
      const names = fs.readdirSync(tree.root).sort();
      const out = path.join(makeTempDir(), 'out.tar');
      const res = run('bsdtar', ['--format', format, '-cf', out, '-C', tree.root, ...names]);
      expect(res.status).toBe(0);
      const entries = readTarEntries(fs.readFileSync(out));
      const byName = new Map(entries.map((e) => [e.filename, e]));
      for (const [rel, data] of Object.entries(tree.files)) {
        expect(byName.get(rel)!.buffer.equals(data)).toBe(true);
      }
      expect(byName.get('emptydir')!.type).toBe('directory');
      expect(byName.get('link-to-plain')!.type).toBe('symlink');
    });
  }
});
