import fs from 'node:fs';
import type { ConversionOptions } from '../types';

/**
 * Targets that hold one stream (gzip, bzip2, xz, zstd) get a tar of the entries unless the archive is exactly one regular
 * file, which is compressed as it is. 7-Zip's gzip, bzip2 and xz handlers update an archive of one item and answer
 * E_INVALIDARG to any other count (`UpdateItems` in GzHandler.cpp, Bz2Handler.cpp, XzHandler.cpp), and `tar -czf`,
 * `-cjf`, `-cJf` write a tar into the stream whatever the output is called (policy entry 87).
 */

/** The 7-Zip codec switch that compresses the tar of a tarball target. */
const TARBALL_CODEC_SWITCH: ReadonlyMap<string, string> = new Map([
  ['tar.gz', '-tgzip'],
  ['tgz', '-tgzip'],
  ['tar.bz2', '-tbzip2'],
  ['tbz2', '-tbzip2'],
  ['tbz', '-tbzip2'],
  ['tar.xz', '-txz'],
  ['txz', '-txz'],
]);

/** The 7-Zip codec switch of a target that holds one stream. */
const SINGLE_STREAM_CODEC_SWITCH: ReadonlyMap<string, string> = new Map([
  ['gz', '-tgzip'],
  ['gzip', '-tgzip'],
  ['bz2', '-tbzip2'],
  ['bzip2', '-tbzip2'],
  ['xz', '-txz'],
]);

/** Whether the extracted tree is exactly one regular file at its root, the one shape a single stream can hold as it is. */
function holdsOneRegularFile(extractDir: string): boolean {
  const entries = fs.readdirSync(extractDir, { withFileTypes: true });
  return entries.length === 1 && entries[0].isFile();
}

/**
 * The 7-Zip codec switch that compresses a tar of the extracted tree for this target, or undefined when the target is
 * packed from the tree itself: not a tarball and not a single-stream codec, or a single-stream codec of one regular file.
 */
export function tarCodecSwitchFor(target: string, extractDir: string): string | undefined {
  const tarball = TARBALL_CODEC_SWITCH.get(target);
  if (tarball) return tarball;
  const singleStream = SINGLE_STREAM_CODEC_SWITCH.get(target);
  return singleStream && !holdsOneRegularFile(extractDir) ? singleStream : undefined;
}

/** What a single-stream target compresses, and the name stem of its output. */
export interface SingleStreamPayload {
  raw: Buffer;
  outputBase: string;
}

interface PayloadFile {
  filename: string;
  buffer: Buffer;
}

type TarWriter = (files: PayloadFile[], options: ConversionOptions, archiveName: string) => { buffer: Buffer };

/**
 * The bytes of a single-stream target made from the entries of an archive: one regular file (a path with no folder) as it
 * is, under the source's file name; any other set as a tar written by `writeTar`, under the stem of the original name.
 */
export function singleStreamPayload(
  files: PayloadFile[],
  options: ConversionOptions,
  names: { baseName: string; sourceFilename: string },
  writeTar: TarWriter
): SingleStreamPayload {
  const [only] = files;
  if (files.length === 1 && !only.filename.includes('/')) return { raw: only.buffer, outputBase: names.sourceFilename };
  return { raw: writeTar(files, options, `${names.baseName}.tar`).buffer, outputBase: names.baseName };
}
