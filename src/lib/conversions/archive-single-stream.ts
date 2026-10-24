import fs from 'node:fs';
import type { ConversionOptions } from '../types';

/**
 * Targets that hold one stream (gzip, bzip2, xz, zstd) get a tar of the entries unless the archive is exactly one regular
 * file, which is compressed as it is. 7-Zip's gzip, bzip2 and xz handlers update an archive of one item and answer
 * E_INVALIDARG to any other count (`UpdateItems` in GzHandler.cpp, Bz2Handler.cpp, XzHandler.cpp), and `tar -czf`,
 * `-cjf`, `-cJf` write a tar into the stream, and the file is then named after the codec's tarball target (`tar.gz`,
 * `tar.bz2`, `tar.xz`, `tar.zst`) so that its name says what it holds (policy entry 87).
 */

/** The tarball target of each single-stream target, and the MIME type the tarball target answers with. */
const STREAM_TARBALL: ReadonlyMap<string, { format: string; mimeType: string }> = new Map(
  (
    [
      [['gz', 'gzip'], 'tar.gz', 'application/gzip'],
      [['bz2', 'bz', 'bzip2'], 'tar.bz2', 'application/x-bzip-compressed-tar'],
      [['xz'], 'tar.xz', 'application/x-xz-compressed-tar'],
      [['zst', 'zstd'], 'tar.zst', 'application/x-zstd-compressed-tar'],
    ] as const
  ).flatMap(([targets, format, mimeType]) => targets.map((target) => [target, { format, mimeType }] as const))
);

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

/** A tar of the extracted tree compressed with one codec: the 7-Zip switch that writes it, and the format the file is named after. */
export interface TarPlan {
  codecSwitch: string;
  outputFormat: string;
}

/**
 * The tar this target is written as, or undefined when the target is packed from the tree itself: not a tarball and not
 * a single-stream codec, or a single-stream codec of one regular file.
 */
export function tarPlanFor(target: string, extractDir: string): TarPlan | undefined {
  const tarball = TARBALL_CODEC_SWITCH.get(target);
  if (tarball) return { codecSwitch: tarball, outputFormat: target };
  const singleStream = SINGLE_STREAM_CODEC_SWITCH.get(target);
  const stream = STREAM_TARBALL.get(target);
  return singleStream && stream && !holdsOneRegularFile(extractDir) ? { codecSwitch: singleStream, outputFormat: stream.format } : undefined;
}

/** What a single-stream target compresses, and the name and MIME type of its output. */
export interface SingleStreamPayload {
  raw: Buffer;
  filename: string;
  mimeType: string;
}

interface PayloadFile {
  filename: string;
  buffer: Buffer;
}

type TarWriter = (files: PayloadFile[], options: ConversionOptions, archiveName: string) => { buffer: Buffer };

/**
 * The bytes of a single-stream target made from the entries of an archive, with the name and MIME type of the output:
 * one regular file (a path with no folder) as it is, under the source's file name and the stream's own MIME type; any
 * other set as a tar written by `writeTar`, named `<base>.tar.<codec>` with the MIME type of that tarball target.
 */
export function singleStreamPayload(
  files: PayloadFile[],
  options: ConversionOptions,
  names: { baseName: string; sourceFilename: string; target: string; streamMimeType: string },
  writeTar: TarWriter
): SingleStreamPayload {
  const [only] = files;
  if (files.length === 1 && !only.filename.includes('/')) {
    return { raw: only.buffer, filename: `${names.sourceFilename}.${names.target}`, mimeType: names.streamMimeType };
  }
  const tarball = STREAM_TARBALL.get(names.target);
  if (!tarball) throw new Error(`'${names.target}' is not a single-stream archive target`);
  return { raw: writeTar(files, options, `${names.baseName}.tar`).buffer, filename: `${names.baseName}.${tarball.format}`, mimeType: tarball.mimeType };
}
