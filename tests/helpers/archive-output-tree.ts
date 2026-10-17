import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { requireOracleTool } from './differential-oracle';

/**
 * Reads the file tree of an archive with tools other than the production engines: JSZip for ZIP, the system `tar` for the
 * tar family and the system 7-Zip for 7z. The tools unpack into a scratch directory that is removed afterwards, and the
 * tree is read back with `lstat`, so a symbolic link is reported as a link and never followed.
 */

const EXTRACT_TIMEOUT_MS = 60_000;
const LISTING_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const ZIP_FILE_TYPE_MASK = 0o170000;
const ZIP_SYMLINK_TYPE = 0o120000;

export interface ArchiveTree {
  /** Regular files by forward-slash path relative to the archive root, without a leading `./`. */
  files: Map<string, Buffer>;
  /** Symbolic links by path, with the target they were stored with. */
  links: Map<string, string>;
}

function walk(root: string): ArchiveTree {
  const tree: ArchiveTree = { files: new Map(), links: new Map() };
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (stat.isSymbolicLink()) tree.links.set(relative, fs.readlinkSync(full));
      else if (stat.isDirectory()) pending.push(full);
      else if (stat.isFile()) tree.files.set(relative, fs.readFileSync(full));
    }
  }
  return tree;
}

async function readZipTree(archive: Buffer): Promise<ArchiveTree> {
  const zip = await JSZip.loadAsync(archive);
  const tree: ArchiveTree = { files: new Map(), links: new Map() };
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const mode = typeof entry.unixPermissions === 'number' ? entry.unixPermissions : 0;
    const content = await entry.async('nodebuffer');
    if ((mode & ZIP_FILE_TYPE_MASK) === ZIP_SYMLINK_TYPE) tree.links.set(name, content.toString('utf8'));
    else tree.files.set(name, content);
  }
  return tree;
}

/** The files and links of an archive of `format` (zip, tar, tar.gz, tar.bz2 or 7z), read by an independent tool. */
export async function readArchiveTree(archive: Buffer, format: string): Promise<ArchiveTree> {
  if (format === 'zip') return readZipTree(archive);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-output-tree-'));
  try {
    const archiveFile = path.join(workDir, `archive.${format}`);
    const outDir = path.join(workDir, 'out');
    fs.writeFileSync(archiveFile, archive);
    fs.mkdirSync(outDir);
    const options = { timeout: EXTRACT_TIMEOUT_MS, maxBuffer: LISTING_MAX_BUFFER_BYTES, stdio: 'pipe' as const };
    if (format === '7z') {
      execFileSync(requireOracleTool('7z'), ['x', '-y', `-o${outDir}`, archiveFile], options);
    } else {
      execFileSync(requireOracleTool('tar'), ['-xf', archiveFile, '-C', outDir], options);
    }
    return walk(outDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** The tree an independent unpacker writes: `run` receives an empty directory and fills it. */
export function unpackWith(run: (outDir: string) => void): ArchiveTree {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-oracle-tree-'));
  try {
    run(workDir);
    return walk(workDir);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** Path to SHA-256, sorted by path: equality of two of these names the first file that differs. */
export function fileDigests(files: Map<string, Buffer>): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const name of [...files.keys()].sort()) {
    digests[name] = createHash('sha256').update(files.get(name)!).digest('hex');
  }
  return digests;
}

/**
 * The permission string each entry of an archive carries (`-rwxr-xr-x`, `drwxrwxrwx`, with `s`, `S`, `t` or `T` where a
 * set-user-ID, set-group-ID or sticky bit is stored), by path, read from the listing of the system `tar`, `zipinfo` or 7-Zip.
 */
export function listPermissionStrings(archive: Buffer, format: string): Map<string, string> {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-output-modes-'));
  try {
    const archiveFile = path.join(workDir, `archive.${format}`);
    fs.writeFileSync(archiveFile, archive);
    const modes = new Map<string, string>();
    const options = { encoding: 'utf8' as const, timeout: EXTRACT_TIMEOUT_MS, maxBuffer: LISTING_MAX_BUFFER_BYTES };
    if (format === '7z') {
      const listing = execFileSync(requireOracleTool('7z'), ['l', '-slt', '-ba', archiveFile], options);
      for (const block of listing.split(/\n\n+/)) {
        const entryPath = /^Path = (.*)$/m.exec(block)?.[1];
        const attributes = /^Attributes = (.*)$/m.exec(block)?.[1];
        const permissions = attributes === undefined ? undefined : /[-dl][-rwxsStT]{9}/.exec(attributes)?.[0];
        if (entryPath !== undefined && permissions !== undefined) modes.set(entryPath.replace(/^\.\//, '').replace(/\/$/, ''), permissions);
      }
      return modes;
    }
    const listing =
      format === 'zip'
        ? execFileSync(requireOracleTool('zipinfo'), [archiveFile], options)
        : execFileSync(requireOracleTool('tar'), ['-tvf', archiveFile], options);
    for (const line of listing.split('\n')) {
      const match = /^([-dlbcps][-rwxsStT]{9})\s.*?(\S+)$/.exec(line.trimEnd());
      if (match) modes.set(match[2].replace(/^\.\//, '').replace(/\/$/, ''), match[1]);
    }
    return modes;
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}
