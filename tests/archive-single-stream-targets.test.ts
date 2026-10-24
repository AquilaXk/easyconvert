import { afterAll, beforeAll, describe, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertArchive } from '../src/lib/conversions/archive';
import { convertWithNative7z } from '../src/worker/engines';
import { sha256Hex } from './helpers/archive-corpus';
import { getOracleToolPath, type ExternalOracleTool } from './helpers/differential-oracle';
import {
  buildDeepTar,
  buildManyEntriesZip,
  buildTarWithEntries,
  createHostileWorkspace,
  type HostileWorkspace,
} from './helpers/hostile-archives';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A gzip, bzip2 or xz file holds one stream, so an archive of several entries is written as a tar of its entries
 * compressed with that codec (what `tar -czf`, `tar -cjf` and `tar -cJf` write whatever the file is called); an archive
 * of exactly one regular file is compressed as that file. 7-Zip alone refuses the several-entries case: its gzip, bzip2
 * and xz handlers answer E_INVALIDARG to an update of more than one item (GzHandler.cpp, Bz2Handler.cpp and
 * XzHandler.cpp, `UpdateItems`). Every output is opened by the system tools, never by the product's own readers.
 */
const TOOLS = ['7z', 'tar', 'zip', 'gzip', 'bzip2', 'xz', 'python3'] as const;
const TEST_TIMEOUT_MS = 180_000;
const MIB = 1024 * 1024;
const OVER_CAP_ENTRY_COUNT = 50_001;
const HOSTILE_DEPTH = 1000;

type Codec = 'gzip' | 'bzip2' | 'xz';
interface SingleStreamTarget {
  target: string;
  codec: Codec;
  /** The extension and MIME type of the same codec's tarball target, which a tar of several entries is named after. */
  tarball: string;
  tarballMime: string;
}

const GZIP_TARBALL = { tarball: 'tar.gz', tarballMime: 'application/gzip' };
const BZIP2_TARBALL = { tarball: 'tar.bz2', tarballMime: 'application/x-bzip-compressed-tar' };
const XZ_TARBALL = { tarball: 'tar.xz', tarballMime: 'application/x-xz-compressed-tar' };

const SINGLE_STREAM_TARGETS: SingleStreamTarget[] = [
  { target: 'gz', codec: 'gzip', ...GZIP_TARBALL },
  { target: 'gzip', codec: 'gzip', ...GZIP_TARBALL },
  { target: 'bz2', codec: 'bzip2', ...BZIP2_TARBALL },
  { target: 'bzip2', codec: 'bzip2', ...BZIP2_TARBALL },
  { target: 'xz', codec: 'xz', ...XZ_TARBALL },
];

const FILES: Record<string, string> = {
  'readme.txt': 'readme '.repeat(500),
  'docs/guide.txt': 'guide\n'.repeat(300),
  'docs/deep/records.csv': 'id,value\n1,2\n3,4\n'.repeat(200),
};
const EMPTY_DIRECTORY = 'emptydir';
const SOURCE_FORMATS = ['zip', '7z', 'tar'] as const;
type SourceFormat = (typeof SOURCE_FORMATS)[number];

let workDir = '';
let treeDir = '';
let ws: HostileWorkspace;
const sources = new Map<string, Buffer>();

function toolPath(tool: ExternalOracleTool): string {
  const bin = getOracleToolPath(tool);
  if (bin === null) throw new Error(`${tool} is required`);
  return bin;
}

function buildTree(root: string, files: Record<string, string>, emptyDirectories: string[] = []): void {
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  for (const directory of emptyDirectories) fs.mkdirSync(path.join(root, directory), { recursive: true });
}

function pack(format: SourceFormat, root: string, name: string, members: string[]): Buffer {
  const archive = path.join(workDir, name);
  if (format === 'zip') execFileSync(toolPath('zip'), ['-q', '-r', archive, ...members], { cwd: root });
  else if (format === '7z') execFileSync(toolPath('7z'), ['a', '-t7z', '-y', archive, ...members], { cwd: root, stdio: 'ignore' });
  else execFileSync(toolPath('tar'), ['--format=ustar', '-cf', archive, '-C', root, ...members], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  return fs.readFileSync(archive);
}

function sourceOf(format: SourceFormat): Buffer {
  const bytes = sources.get(format);
  if (bytes === undefined) throw new Error(`no ${format} fixture`);
  return bytes;
}

function decode(codec: Codec, stream: Buffer): Buffer {
  const result = spawnSync(toolPath(codec), ['-d', '-c'], { input: stream, maxBuffer: 64 * MIB });
  if (result.status !== 0) throw new Error(`${codec} -d rejected the output: ${result.stderr.toString()}`);
  return result.stdout;
}

/** Unpacks a tar with the system tar into a fresh directory and returns it; bsdtar also reads ZIP and 7z, so the magic is checked first. */
function untar(tar: Buffer, name: string): string {
  expect(tar.toString('latin1', 257, 262), `${name} is not a tar`).toBe('ustar');
  const file = path.join(workDir, `${name}.tar`);
  fs.writeFileSync(file, tar);
  const into = path.join(workDir, `${name}-unpacked`);
  fs.mkdirSync(into);
  execFileSync(toolPath('tar'), ['-xf', file, '-C', into]);
  return into;
}

function tarMembers(tar: Buffer, name: string): string[] {
  expect(tar.toString('latin1', 257, 262), `${name} is not a tar`).toBe('ustar');
  const file = path.join(workDir, `${name}-list.tar`);
  fs.writeFileSync(file, tar);
  return execFileSync(toolPath('tar'), ['-tf', file], { encoding: 'utf8' })
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => entry.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((entry) => entry !== '.')
    .sort();
}

/** Regular files of an archive as `7z l -slt` lists them: path to size. */
function listedFiles(archive: string): Map<string, number> {
  const files = new Map<string, number>();
  const listing = execFileSync(toolPath('7z'), ['l', '-slt', '-ba', archive], { encoding: 'utf8', maxBuffer: 256 * MIB });
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const at = line.indexOf(' = ');
      if (at > 0) fields.set(line.slice(0, at), line.slice(at + 3));
    }
    const entryPath = fields.get('Path');
    const isFolder = fields.get('Folder') === '+' || (fields.get('Attributes') ?? '').startsWith('D');
    if (entryPath === undefined || isFolder) continue;
    files.set(entryPath.replace(/^\.\//, ''), Number(fields.get('Size') ?? 0));
  }
  return files;
}

function filesUnder(root: string): Map<string, string> {
  const found = new Map<string, string>();
  const visit = (relative: string): void => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const entryPath = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(entryPath);
      else found.set(entryPath, sha256Hex(fs.readFileSync(path.join(root, entryPath))));
    }
  };
  visit('');
  return found;
}

function expectedHashes(files: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(files).map(([name, text]) => [name, sha256Hex(Buffer.from(text))]));
}

async function workerResult(input: Buffer, src: string, tgt: string, name: string, options = {}) {
  const result = await convertWithNative7z(input, src, tgt, options, name);
  if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
  return result;
}

async function viaWorker(input: Buffer, src: string, tgt: string, name: string, options = {}): Promise<Buffer> {
  return (await workerResult(input, src, tgt, name, options)).buffer as Buffer;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected a typed rejection but the operation completed');
    },
    (error: unknown) => error
  );
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-stream-targets-'));
  treeDir = path.join(workDir, 'tree');
  buildTree(treeDir, FILES, [EMPTY_DIRECTORY]);
  if (getOracleToolPath('zip') && getOracleToolPath('7z') && getOracleToolPath('tar')) {
    for (const format of SOURCE_FORMATS) sources.set(format, pack(format, treeDir, `several.${format}`, ['readme.txt', 'docs', EMPTY_DIRECTORY]));
  }
  ws = createHostileWorkspace();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  ws.cleanup();
});

describe('an archive of several entries to a single-stream target, worker engine', () => {
  for (const { target, codec, tarball, tarballMime } of SINGLE_STREAM_TARGETS) {
    for (const format of SOURCE_FORMATS) {
      oracleTest(
        `${format} to ${target} is a ${codec} stream holding a tar of every entry`,
        [...TOOLS],
        async () => {
          const result = await workerResult(sourceOf(format), format, target, `several.${format}`);
          expect(result.filename).toBe(`several.${tarball}`);
          expect(result.mimeType).toBe(tarballMime);
          const tar = decode(codec, result.buffer as Buffer);
          expect(tarMembers(tar, `${format}-${target}`)).toEqual(['docs', 'docs/deep', 'docs/deep/records.csv', 'docs/guide.txt', EMPTY_DIRECTORY, 'readme.txt']);
          const unpacked = untar(tar, `${format}-${target}`);
          expect(filesUnder(unpacked)).toEqual(expectedHashes(FILES));
          expect(fs.statSync(path.join(unpacked, EMPTY_DIRECTORY)).isDirectory()).toBe(true);
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'the output is what `tar -czf` writes: the system tar reads it as a gzipped tar without being told',
    [...TOOLS],
    async () => {
      const output = await viaWorker(sourceOf('zip'), 'zip', 'gz', 'several.zip');
      const file = path.join(workDir, 'as-written.tar.gz');
      fs.writeFileSync(file, output);
      execFileSync(toolPath('gzip'), ['-t', file]);
      const listed = execFileSync(toolPath('tar'), ['-tzf', file], { encoding: 'utf8' });
      const members = listed.split('\n').filter((entry) => entry !== '').map((entry) => entry.replace(/\/$/, ''));
      expect(members.sort()).toEqual(['docs', 'docs/deep', 'docs/deep/records.csv', 'docs/guide.txt', EMPTY_DIRECTORY, 'readme.txt']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a source holding exactly one regular file is compressed as that file, with no tar around it',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'single-tree');
      buildTree(root, { 'only.txt': 'the only file\n'.repeat(200) });
      for (const format of SOURCE_FORMATS) {
        for (const { target, codec } of SINGLE_STREAM_TARGETS) {
          const result = await workerResult(pack(format, root, `only.${format}`, ['only.txt']), format, target, `only.${format}`);
          expect(decode(codec, result.buffer as Buffer).toString(), `${format} to ${target}`).toBe('the only file\n'.repeat(200));
          expect(result.filename, `${format} to ${target}`).toBe(`only.${target}`);
        }
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a single file inside a folder keeps its path in a tar',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'nested-tree');
      buildTree(root, { 'folder/inner.txt': 'inner\n'.repeat(100) });
      for (const format of SOURCE_FORMATS) {
        const result = await workerResult(pack(format, root, `nested.${format}`, ['folder']), format, 'gz', `nested.${format}`);
        expect(result.filename, format).toBe('nested.tar.gz');
        expect(tarMembers(decode('gzip', result.buffer as Buffer), `nested-${format}`), format).toEqual(['folder', 'folder/inner.txt']);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a tar whose only entry is a file inside a folder is a tar in the gzip stream, named .tar.gz',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'bare-nested-tree');
      buildTree(root, { 'folder/inner.txt': 'inner\n'.repeat(100) });
      const result = await workerResult(pack('tar', root, 'bare-nested.tar', ['folder/inner.txt']), 'tar', 'gz', 'bare-nested.tar');
      expect(result.filename).toBe('bare-nested.tar.gz');
      expect(result.mimeType).toBe('application/gzip');
      expect(tarMembers(decode('gzip', result.buffer as Buffer), 'bare-nested')).toEqual(['folder/inner.txt']);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the compression level reaches the codec: level 0 writes a larger gzip stream than level 9 of the same tar',
    [...TOOLS],
    async () => {
      const stored = await viaWorker(sourceOf('zip'), 'zip', 'gz', 'several.zip', { compressionLevel: 0 });
      const smallest = await viaWorker(sourceOf('zip'), 'zip', 'gz', 'several.zip', { compressionLevel: 9 });
      expect(stored.length).toBeGreaterThan(smallest.length);
      expect(decode('gzip', stored).equals(decode('gzip', smallest))).toBe(true);
    },
    TEST_TIMEOUT_MS
  );
});

describe('an archive of several entries to a single-stream target, in-process engine', () => {
  for (const { target, codec, tarball, tarballMime } of SINGLE_STREAM_TARGETS.filter((entry) => entry.target !== 'gzip' && entry.target !== 'bzip2')) {
    for (const format of SOURCE_FORMATS) {
      oracleTest(
        `${format} to ${target} is a ${codec} stream holding a tar of every entry`,
        [...TOOLS],
        async () => {
          const result = await convertArchive(sourceOf(format), format, target, {}, `several.${format}`);
          const tar = decode(codec, result.buffer);
          const unpacked = untar(tar, `inproc-${format}-${target}`);
          expect(filesUnder(unpacked)).toEqual(expectedHashes(FILES));
          expect(result.filename).toBe(`several.${tarball}`);
          expect(result.mimeType).toBe(tarballMime);
        },
        TEST_TIMEOUT_MS
      );
    }
  }

  oracleTest(
    'zst targets get the tar of the entries too, as zstd reads it back',
    ['zstd', 'tar', 'zip'],
    async () => {
      const result = await convertArchive(sourceOf('zip'), 'zip', 'zst', {}, 'several.zip');
      const decoded = spawnSync(toolPath('zstd'), ['-d', '-c'], { input: result.buffer, maxBuffer: 64 * MIB });
      expect(decoded.status).toBe(0);
      expect(filesUnder(untar(decoded.stdout, 'inproc-zst'))).toEqual(expectedHashes(FILES));
      expect(result.filename).toBe('several.tar.zst');
      expect(result.mimeType).toBe('application/x-zstd-compressed-tar');
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'one regular file is compressed as that file',
    [...TOOLS],
    async () => {
      const root = path.join(workDir, 'inproc-single');
      buildTree(root, { 'only.txt': 'the only file\n'.repeat(200) });
      const result = await convertArchive(pack('zip', root, 'inproc-only.zip', ['only.txt']), 'zip', 'gz', {}, 'inproc-only.zip');
      expect(decode('gzip', result.buffer).toString()).toBe('the only file\n'.repeat(200));
      expect(result.filename).toBe('inproc-only.zip.gz');
    },
    TEST_TIMEOUT_MS
  );
});

describe('the listing of the source decides the entries of the output (real files)', () => {
  const REAL_SAMPLES: Array<{ id: string; format: SourceFormat; target: string }> = [
    { id: 'cc-cygwin_gnu.tar', format: 'tar', target: 'gz' },
    { id: 'tika-test-documents.tar', format: 'tar', target: 'gz' },
    { id: 'tika-test-documents.zip', format: 'zip', target: 'gz' },
    { id: 'cc-freebsd.zip', format: 'zip', target: 'gz' },
    { id: 'cc-lzma2.7z', format: '7z', target: 'gz' },
  ];
  for (const { id, format, target } of REAL_SAMPLES) {
    oracleTest(
      `${id} to ${target} is a gzip file whose tar lists the files of the source`,
      [...TOOLS],
      async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        const result = await workerResult(sample.bytes, format, target, id);
        const output = result.buffer as Buffer;
        expect(result.filename).toBe(`${id.replace(/\.[^.]+$/, '')}.tar.gz`);
        const file = path.join(workDir, `${id}.${target}`);
        fs.writeFileSync(file, output);
        execFileSync(toolPath('gzip'), ['-t', file]);
        const unpacked = untar(decode('gzip', output), `real-${id}`);
        const listed = listedFiles(sample.path);
        const unpackedFiles = filesUnder(unpacked);
        expect([...unpackedFiles.keys()].sort()).toEqual([...listed.keys()].sort());
        for (const [entryPath, size] of listed) expect(fs.statSync(path.join(unpacked, entryPath)).size, entryPath).toBe(size);
      },
      TEST_TIMEOUT_MS
    );
  }
});

describe('the extraction policy still applies before the tar is written', () => {
  oracleTest(
    'a traversing name is refused with the typed error and nothing is written outside',
    [...TOOLS],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'slip.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: '../../../outside/pwned.txt', data: 'pwned' },
        ])
      );
      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        for (const target of ['gz', 'bz2', 'xz']) {
          await expect(convertWithNative7z(tar, 'tar', target, {}, 'slip.tar'), target).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-traversal' });
        }
      });
      expect(ws.snapshot()).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a symlink entry is refused, and with skipLinks left out and named',
    [...TOOLS],
    async () => {
      const tar = fs.readFileSync(
        buildTarWithEntries(path.join(ws.fixturesDir, 'link.tar'), [
          { name: 'ok.txt', data: 'fine' },
          { name: 'second.txt', data: 'also fine' },
          { name: 'sym', kind: 'symlink', target: ws.outsideDir },
        ])
      );
      const before = ws.snapshot();
      await ws.withTmpdir(async () => {
        await expect(convertWithNative7z(tar, 'tar', 'gz', {}, 'link.tar')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'link-entry' });
        const result = await convertWithNative7z(tar, 'tar', 'gz', { skipLinks: true }, 'link.tar');
        if (result === null) throw new Error('the native 7-Zip engine declined the conversion');
        expect(result.skippedLinks).toEqual(['sym']);
        expect(tarMembers(decode('gzip', result.buffer as Buffer), 'skip-links')).toEqual(['ok.txt', 'second.txt']);
      });
      expect(ws.snapshot().filter((line) => !line.includes('easyconvert-vfs'))).toEqual(before);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'more entries than the cap are refused for every single-stream target as they are for a tar',
    [...TOOLS],
    async () => {
      const zip = fs.readFileSync(buildManyEntriesZip(path.join(ws.fixturesDir, 'many.zip'), OVER_CAP_ENTRY_COUNT));
      const reference = await rejection(convertWithNative7z(zip, 'zip', 'tar', {}, 'many.zip'));
      expect(reference).toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
      for (const target of ['gz', 'bz2', 'xz']) {
        await expect(convertWithNative7z(zip, 'zip', target, {}, 'many.zip'), target).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'entry-count' });
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a path nested past the depth cap is refused',
    [...TOOLS],
    async () => {
      const tar = fs.readFileSync(buildDeepTar(path.join(ws.fixturesDir, 'deep.tar'), HOSTILE_DEPTH));
      await expect(convertWithNative7z(tar, 'tar', 'gz', {}, 'deep.tar')).rejects.toMatchObject({ name: 'UnsafeArchiveError', reason: 'path-depth' });
    },
    TEST_TIMEOUT_MS
  );
});
