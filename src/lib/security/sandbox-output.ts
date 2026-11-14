import fs from 'node:fs';
import path from 'node:path';
import { ConversionFailedError } from '../types';

/**
 * Reads of what a sandboxed program wrote, by the host that started it.
 *
 * A program may make a link where it should write its output (the seccomp profile lets it call symlink, and its job directory allows
 * it to make one), so a read that follows links hands the host any file of its user, which the next step then converts or returns.
 * Every read here opens the file itself with O_NOFOLLOW and judges the open file (fstat) instead of its name: what is checked is
 * what is read, and no swap of the name between the two can change it. O_NONBLOCK keeps the open of a named pipe, which a program
 * may also make, from waiting for a writer that never comes; the pipe is then refused as not a regular file.
 */

/** The flags a read of an output opens with, for the caller that streams or reads the file by its own descriptor. */
export const OUTPUT_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const OUTPUT_WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

/** Called with the size of the open file before a byte is read, to refuse a file that is too large with the error of the caller. */
export type SandboxOutputGuard = (size: number) => void;

/** What a sandboxed program left at its output path was not a regular file: a link, a directory or a special file. */
export class SandboxOutputKindError extends ConversionFailedError {
  constructor(readonly kind: string) {
    super(`The converter left a ${kind} where its output belongs, not a regular file.`);
    this.name = 'SandboxOutputKindError';
  }
}

function kindOf(stat: fs.Stats): string {
  if (stat.isDirectory()) return 'directory';
  return stat.isSymbolicLink() ? 'symbolic link' : 'special file';
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/** The error for a name that opens as a link: O_NOFOLLOW answers ELOOP (EMLINK on some systems) for a link at the last component. */
function refusedLink(error: unknown): unknown {
  return isErrno(error, 'ELOOP') || isErrno(error, 'EMLINK') ? new SandboxOutputKindError('symbolic link') : error;
}

/** The open descriptor and the size of a regular file, or null when there is no such file. */
function openOutput(filePath: string): { fd: number; size: number } | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, OUTPUT_READ_FLAGS);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw refusedLink(error);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SandboxOutputKindError(kindOf(stat));
    return { fd, size: stat.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/** The size of the file at `filePath`, or null when there is none; throws SandboxOutputKindError for anything but a regular file. */
export function sandboxOutputSize(filePath: string): number | null {
  const opened = openOutput(filePath);
  if (opened === null) return null;
  fs.closeSync(opened.fd);
  return opened.size;
}

/** The bytes of the file at `filePath`, or null when there is none; throws SandboxOutputKindError for anything but a regular file. */
export function readSandboxOutputIfPresent(filePath: string, guard?: SandboxOutputGuard): Buffer | null {
  const opened = openOutput(filePath);
  if (opened === null) return null;
  try {
    guard?.(opened.size);
    return fs.readFileSync(opened.fd);
  } finally {
    fs.closeSync(opened.fd);
  }
}

/** The bytes of the file at `filePath`; a missing file fails as `fs.readFileSync` fails (ENOENT). */
export function readSandboxOutput(filePath: string, guard?: SandboxOutputGuard): Buffer {
  const bytes = readSandboxOutputIfPresent(filePath, guard);
  if (bytes === null) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT', path: filePath });
  return bytes;
}

/**
 * The files of `names` in `directory`, read in the order given. A subdirectory is skipped (a program may keep one beside its files),
 * and a link or a special file is refused with SandboxOutputKindError, as it is where one output is read.
 */
export function readSandboxOutputFiles(directory: string, names: readonly string[]): Array<{ name: string; bytes: Buffer }> {
  const files: Array<{ name: string; bytes: Buffer }> = [];
  for (const name of names) {
    const filePath = path.join(directory, name);
    if (fs.lstatSync(filePath).isDirectory()) continue;
    files.push({ name, bytes: readSandboxOutput(filePath) });
  }
  return files;
}

/** `readSandboxOutput` for a caller that must not hold the event loop: the read runs in the thread pool. A missing file fails with ENOENT. */
export async function readSandboxOutputAsync(filePath: string, guard?: SandboxOutputGuard): Promise<Buffer> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(filePath, OUTPUT_READ_FLAGS);
  } catch (error) {
    throw refusedLink(error);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new SandboxOutputKindError(kindOf(stat));
    guard?.(stat.size);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Replaces the content of an output file in place, through no link: for a program's output the host repairs before it goes on. */
export function writeSandboxOutput(filePath: string, data: string | Buffer): void {
  let fd: number;
  try {
    fd = fs.openSync(filePath, OUTPUT_WRITE_FLAGS);
  } catch (error) {
    throw refusedLink(error);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new SandboxOutputKindError(kindOf(stat));
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
