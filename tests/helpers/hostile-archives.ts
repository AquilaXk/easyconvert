import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * Builders for hostile archives. Every fixture is produced by an independent tool (7-Zip, Python's
 * zipfile and tarfile, or plain `ln -s` staging), never by the production engines.
 */

const MIB = 1024 * 1024;
const BUILD_TIMEOUT_MS = 120_000;
/** Room for the listing of an archive with tens of thousands of entries. */
const LISTING_MAX_BUFFER_BYTES = 128 * MIB;
const AES_PASSWORD_SWITCH_PREFIX = '-p';

/** A scratch world with a controlled TMPDIR and a canary directory outside every extraction root. */
export interface HostileWorkspace {
  /** Parent of every other directory here; its tree (minus `fixturesDir`) is snapshotted to detect stray writes. */
  root: string;
  /** Becomes os.tmpdir() while `withTmpdir` runs, so engine sandboxes are created inside the workspace. */
  tmpDir: string;
  /** A directory an extraction must never write into. It holds one canary file. */
  outsideDir: string;
  /** Where fixtures and requested outputs are written; excluded from the snapshot. */
  fixturesDir: string;
  /** Sorted `type path size` lines for every entry below `root` except `fixturesDir`, using lstat. */
  snapshot(): string[];
  withTmpdir<T>(operation: () => Promise<T>): Promise<T>;
  cleanup(): void;
}

function listTree(dir: string, base: string, lines: string[], skip: string): void {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (full === skip) continue;
    const stat = fs.lstatSync(full);
    const rel = path.relative(base, full);
    if (stat.isSymbolicLink()) {
      lines.push(`l ${rel} -> ${fs.readlinkSync(full)}`);
    } else if (stat.isDirectory()) {
      lines.push(`d ${rel}`);
      listTree(full, base, lines, skip);
    } else {
      lines.push(`f ${rel} ${stat.size}`);
    }
  }
}

export function createHostileWorkspace(): HostileWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-hostile-'));
  const tmpDir = path.join(root, 'tmp');
  const outsideDir = path.join(root, 'outside');
  const fixturesDir = path.join(root, 'fixtures');
  fs.mkdirSync(tmpDir);
  fs.mkdirSync(outsideDir);
  fs.mkdirSync(fixturesDir);
  fs.writeFileSync(path.join(outsideDir, 'canary.txt'), 'canary');

  const snapshot = (): string[] => {
    const lines: string[] = [];
    listTree(root, root, lines, fixturesDir);
    return lines;
  };

  const withTmpdir = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = tmpDir;
    try {
      return await operation();
    } finally {
      if (previous === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previous;
      }
    }
  };

  return {
    root,
    tmpDir,
    outsideDir,
    fixturesDir,
    snapshot,
    withTmpdir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function requireTool(tool: '7z' | 'python3'): string {
  const toolPath = getOracleToolPath(tool);
  if (!toolPath) {
    throw new Error(`Hostile archive fixtures require the ${tool} CLI`);
  }
  return toolPath;
}

function runPython(script: string, args: string[]): void {
  execFileSync(requireTool('python3'), ['-c', script, ...args], { stdio: 'pipe', timeout: BUILD_TIMEOUT_MS });
}

function run7z(args: string[], cwd: string): void {
  execFileSync(requireTool('7z'), args, { cwd, stdio: 'pipe', timeout: BUILD_TIMEOUT_MS });
}

const PY_ZIP_ENTRIES = `
import sys, zipfile, json
out, spec = sys.argv[1], json.loads(sys.argv[2])
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    for e in spec:
        info = zipfile.ZipInfo(e['name'])
        info.create_system = 3
        info.external_attr = int(e.get('mode', 0o100644)) << 16
        if 'comment' in e:
            info.comment = e['comment'].encode()
        z.writestr(info, e.get('data', ''))
`;

const PY_TAR_ENTRIES = `
import sys, tarfile, io, json
out, spec = sys.argv[1], json.loads(sys.argv[2])
mode = 'w'
if out.endswith(('.gz', '.tgz')): mode = 'w:gz'
if out.endswith(('.bz2', '.tbz2')): mode = 'w:bz2'
if out.endswith(('.xz', '.txz')): mode = 'w:xz'
with tarfile.open(out, mode) as t:
    for e in spec:
        info = tarfile.TarInfo(e['name'])
        kind = e.get('kind', 'file')
        if kind == 'symlink':
            info.type = tarfile.SYMTYPE
            info.linkname = e['target']
            t.addfile(info)
        elif kind == 'hardlink':
            info.type = tarfile.LNKTYPE
            info.linkname = e['target']
            t.addfile(info)
        elif kind == 'directory':
            info.type = tarfile.DIRTYPE
            t.addfile(info)
        elif kind == 'fifo':
            info.type = tarfile.FIFOTYPE
            t.addfile(info)
        else:
            data = e.get('data', '').encode()
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
`;

const PY_ZERO_BOMB_ZIP = `
import sys, zipfile
out, mib = sys.argv[1], int(sys.argv[2])
chunk = bytes(1024 * 1024)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
    with z.open('zeros.bin', 'w', force_zip64=True) as f:
        for _ in range(mib):
            f.write(chunk)
`;

const PY_MANY_ENTRIES_ZIP = `
import sys, zipfile
out, count = sys.argv[1], int(sys.argv[2])
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    for i in range(count):
        z.writestr('f%05d.txt' % i, 'x')
`;

const PY_COMPRESS_FILE = `
import sys, gzip, bz2, lzma
out, data = sys.argv[1], sys.argv[2].encode()
opener = gzip.open if out.endswith('.gz') else bz2.open if out.endswith('.bz2') else lzma.open
with opener(out, 'wb') as f:
    f.write(data)
`;

const PY_DEEP_TAR = `
import sys, tarfile, io
out, depth = sys.argv[1], int(sys.argv[2])
with tarfile.open(out, 'w') as t:
    info = tarfile.TarInfo('d/' * depth + 'leaf.txt')
    info.size = 4
    t.addfile(info, io.BytesIO(b'leaf'))
`;

const PY_MANY_ENTRIES_TAR = `
import sys, tarfile, io, os
out, count = sys.argv[1], int(sys.argv[2])
with tarfile.open(out, 'w:gz' if out.endswith(('.gz', '.tgz')) else 'w') as t:
    for i in range(count):
        # Random names keep the headers from compressing away, so the entry count (not the ratio) is the limit hit.
        info = tarfile.TarInfo('f%05d-%s' % (i, os.urandom(32).hex()))
        t.addfile(info, io.BytesIO(b''))
`;

export interface ZipEntrySpec {
  name: string;
  data?: string;
  /** Unix st_mode including the file-type bits, e.g. 0o120777 for a symlink. */
  mode?: number;
  /** Per-entry comment, written to the central directory (may hold line breaks). */
  comment?: string;
}

/** A ZIP whose entry names and unix modes are written verbatim by Python's zipfile. */
export function buildZipWithEntries(outPath: string, entries: ZipEntrySpec[]): string {
  runPython(PY_ZIP_ENTRIES, [outPath, JSON.stringify(entries)]);
  return outPath;
}

export interface TarEntrySpec {
  name: string;
  kind?: 'file' | 'symlink' | 'hardlink' | 'fifo' | 'directory';
  data?: string;
  target?: string;
}

/** A TAR whose entry names and link types are written verbatim by Python's tarfile. */
export function buildTarWithEntries(outPath: string, entries: TarEntrySpec[]): string {
  runPython(PY_TAR_ENTRIES, [outPath, JSON.stringify(entries)]);
  return outPath;
}

/** A ZIP holding one DEFLATE entry of `mib` MiB of zeros (a classic decompression bomb). */
export function buildZeroBombZip(outPath: string, mib: number): string {
  runPython(PY_ZERO_BOMB_ZIP, [outPath, String(mib)]);
  return outPath;
}

/** A ZIP of `count` one-byte files, stored without compression. */
export function buildManyEntriesZip(outPath: string, count: number): string {
  runPython(PY_MANY_ENTRIES_ZIP, [outPath, String(count)]);
  return outPath;
}

/**
 * A 7z archive built by 7-Zip itself from a staged directory. The staged files are created with
 * `ln -s` semantics (fs.symlinkSync) and stored as links through `-snl`.
 */
export function build7zFromStagedLinks(
  outPath: string,
  stageDir: string,
  links: Array<{ name: string; target: string }>,
  files: Array<{ name: string; data: string }> = []
): string {
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(stageDir, file.name), file.data);
  }
  for (const link of links) {
    fs.symlinkSync(link.target, path.join(stageDir, link.name));
  }
  const members = [...files.map((f) => f.name), ...links.map((l) => l.name)];
  run7z(['a', '-t7z', '-snl', '-y', outPath, ...members], stageDir);
  return outPath;
}

export interface EncryptedZipSpec {
  password: string;
  /** Files to store, written into the staging directory before 7-Zip packs them. */
  files?: Array<{ name: string; data: string | Buffer }>;
  /** Symlinks to stage and store as links. */
  links?: Array<{ name: string; target: string }>;
  /** Extra zero bytes to append as one sparse file (compresses to almost nothing). */
  zeroFileMib?: number;
  /** Extra one-byte files named f00000.txt, f00001.txt, ... */
  manyFiles?: number;
  /** ZipCrypto is far cheaper per entry than AES, which matters for tens of thousands of entries. */
  cipher?: 'AES256' | 'ZipCrypto';
}

/** An AES-256 encrypted ZIP built by 7-Zip from a staged directory. */
export function buildEncryptedZip(outPath: string, stageDir: string, spec: EncryptedZipSpec): string {
  fs.mkdirSync(stageDir, { recursive: true });
  const members: string[] = [];
  for (const file of spec.files ?? []) {
    fs.writeFileSync(path.join(stageDir, file.name), file.data);
    members.push(file.name);
  }
  for (const link of spec.links ?? []) {
    fs.symlinkSync(link.target, path.join(stageDir, link.name));
    members.push(link.name);
  }
  if (spec.zeroFileMib) {
    const zeroPath = path.join(stageDir, 'zeros.bin');
    fs.closeSync(fs.openSync(zeroPath, 'w'));
    fs.truncateSync(zeroPath, spec.zeroFileMib * MIB);
    members.push('zeros.bin');
  }
  for (let i = 0; i < (spec.manyFiles ?? 0); i++) {
    const name = `f${String(i).padStart(5, '0')}.txt`;
    fs.writeFileSync(path.join(stageDir, name), 'x');
    members.push(name);
  }
  run7z(
    ['a', '-tzip', '-snl', '-mx=1', `-mem=${spec.cipher ?? 'AES256'}`, `${AES_PASSWORD_SWITCH_PREFIX}${spec.password}`, '-y', outPath, ...members],
    stageDir
  );
  return outPath;
}

/**
 * Rewrites an entry name inside a finished ZIP. Names sit in plain text in both the local header and
 * the central directory (even for encrypted entries) and the CRC covers only the data, so a
 * same-length replacement yields a valid archive whose entry name 7-Zip itself would never write.
 */
export function patchZipEntryName(zipPath: string, placeholder: string, replacement: string): void {
  if (Buffer.byteLength(placeholder) !== Buffer.byteLength(replacement)) {
    throw new Error('patchZipEntryName requires a replacement of identical byte length');
  }
  const original = fs.readFileSync(zipPath);
  const needle = Buffer.from(placeholder);
  const swap = Buffer.from(replacement);
  let patched = 0;
  let from = 0;
  for (;;) {
    const at = original.indexOf(needle, from);
    if (at === -1) break;
    swap.copy(original, at);
    patched++;
    from = at + needle.length;
  }
  if (patched === 0) {
    throw new Error(`Placeholder ${placeholder} not found in ${zipPath}`);
  }
  fs.writeFileSync(zipPath, original);
}

/** Lists an archive with the real 7-Zip CLI and returns each entry's path (independent oracle). */
export function list7zEntryPaths(archivePath: string): string[] {
  const out = execFileSync(requireTool('7z'), ['l', '-slt', '-ba', archivePath], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: LISTING_MAX_BUFFER_BYTES,
  });
  return out
    .split('\n')
    .filter((line) => line.startsWith('Path = '))
    .map((line) => line.slice('Path = '.length));
}

/** A TAR (gzip-compressed when the name ends in .gz or .tgz) of `count` empty files with incompressible names. */
export function buildManyEntriesTar(outPath: string, count: number): string {
  runPython(PY_MANY_ENTRIES_TAR, [outPath, String(count)]);
  return outPath;
}

/** A 7z archive, packed by 7-Zip, of `count` empty files staged in `stageDir`. */
export function build7zWithManyFiles(outPath: string, stageDir: string, count: number): string {
  fs.mkdirSync(stageDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    fs.writeFileSync(path.join(stageDir, `f${String(i).padStart(5, '0')}.txt`), '');
  }
  run7z(['a', '-t7z', '-mx=1', '-y', outPath, '.'], stageDir);
  return outPath;
}

/** A 7z archive holding one sparse zero file of `mib` MiB (compresses to a few KiB). */
export function build7zZeroBomb(outPath: string, stageDir: string, mib: number): string {
  fs.mkdirSync(stageDir, { recursive: true });
  const zeroPath = path.join(stageDir, 'zeros.bin');
  fs.closeSync(fs.openSync(zeroPath, 'w'));
  fs.truncateSync(zeroPath, mib * MIB);
  run7z(['a', '-t7z', '-mx=1', '-y', outPath, 'zeros.bin'], stageDir);
  return outPath;
}

/** A single-stream compressed file (.gz, .bz2 or .xz by suffix) holding `content`, written by Python. */
export function buildCompressedFile(outPath: string, content: string): string {
  runPython(PY_COMPRESS_FILE, [outPath, content]);
  return outPath;
}

/** A TAR holding one file under `depth` nested directories. */
export function buildDeepTar(outPath: string, depth: number): string {
  runPython(PY_DEEP_TAR, [outPath, String(depth)]);
  return outPath;
}

/** A 7z archive with encrypted content and, when `encryptHeaders` is set, encrypted entry names. */
export function build7zEncrypted(
  outPath: string,
  stageDir: string,
  password: string,
  files: Array<{ name: string; data: string }>,
  encryptHeaders: boolean
): string {
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of files) {
    fs.writeFileSync(path.join(stageDir, file.name), file.data);
  }
  run7z(
    ['a', '-t7z', `-mhe=${encryptHeaders ? 'on' : 'off'}`, `${AES_PASSWORD_SWITCH_PREFIX}${password}`, '-y', outPath, ...files.map((f) => f.name)],
    stageDir
  );
  return outPath;
}
