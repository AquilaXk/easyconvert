import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FamilyContext } from '../context';
import { OutputIntegrityError } from '../errors';
import { runTool } from '../tools';

/** What the compression rows share: the mixed input, its tar, the check that a decode is the original, and interleaved timing. */

export const MIXED_NAME = 'mixed.bin';
export const MIXED_INPUT_FILES = ['data/records.jsonl', 'speech.wav'];

export interface MixedFixture {
  /** Directory holding the member, which the reference tools compress in place. */
  dir: string;
  /** File name of the member inside `dir` and inside the archives. */
  member: string;
  path: string;
  original: Buffer;
  tar: Buffer;
}

/** The single member of a tar, read with the system tar. */
export function tarMember(tar: Buffer, tarBin: string): Buffer {
  return runTool(tarBin, ['-xOf', '-'], { input: tar }).stdout;
}

const USTAR_MAGIC_OFFSET = 257;

/** Whether the bytes are a tar archive (a ustar header at the first block). */
function holdsTarArchive(bytes: Buffer): boolean {
  return bytes.length > USTAR_MAGIC_OFFSET + 5 && bytes.subarray(USTAR_MAGIC_OFFSET, USTAR_MAGIC_OFFSET + 5).toString('latin1') === 'ustar';
}

/** Path, size and SHA-256 of every file below `dir`, one line each, in path order. */
function treeDigest(dir: string): string {
  const lines: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) lines.push(`${path.relative(dir, full)} ${fs.statSync(full).size} ${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(dir);
  return lines.join('\n');
}

function extractedDigest(ctx: FamilyContext, tarBin: string, archive: Buffer, name: string): string {
  const dir = ctx.scratch(name);
  fs.mkdirSync(dir);
  runTool(tarBin, ['-xf', '-', '-C', dir], { input: archive });
  return treeDigest(dir);
}

/**
 * What a conversion of a compressed stream to tar yields, read back to the one file it holds. Content that is itself a tar
 * archive (the Silesia files `xml`, `samba` and `mozilla` are) comes back as an archive with the same entries: the product
 * writes the entries again, so the bytes of the archive differ in padding while every file in it is the same, and the check
 * compares the files. Any other content is wrapped as the only member of a new tar.
 */
export function streamTarMember(ctx: FamilyContext, output: Buffer, original: Buffer, tarBin: string): Buffer {
  if (!holdsTarArchive(original) || output.equals(original)) return holdsTarArchive(original) ? output : tarMember(output, tarBin);
  return extractedDigest(ctx, tarBin, output, 'stream-output') === extractedDigest(ctx, tarBin, original, 'stream-original') ? original : output;
}

export function assertSame(label: string, actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new OutputIntegrityError(`${label} does not decode to the original ${expected.length} bytes (got ${actual.length})`);
}

/** One file as the single member of a directory, and a reproducible tar of it. */
export function buildFixture(ctx: FamilyContext, tarBin: string, memberName: string, original: Buffer): MixedFixture {
  const dir = ctx.scratch(`fixture-${memberName}`);
  fs.mkdirSync(dir);
  const member = path.join(dir, memberName);
  fs.writeFileSync(member, original);
  const tarFile = ctx.scratch(`${memberName}.tar`);
  runTool(tarBin, ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', tarFile, '-C', dir, memberName]);
  return { dir, member: memberName, path: member, original, tar: fs.readFileSync(tarFile) };
}

/** The corpus files joined into one member, and a reproducible tar of it. */
export function buildMixedFixture(ctx: FamilyContext, tarBin: string): MixedFixture {
  return buildFixture(ctx, tarBin, MIXED_NAME, Buffer.concat(MIXED_INPUT_FILES.map((file) => ctx.corpusBuffer(file))));
}

/** Interleaved timing of two actions whose results are not needed; `oursRepeats` calls of ours make one sample. */
export function timeBoth(ctx: FamilyContext, rowId: string, ours: () => Promise<unknown>, reference: () => unknown, oursRepeats = 1): ReturnType<FamilyContext['time']> {
  return ctx.time(
    rowId,
    async () => {
      await ours();
    },
    () => {
      reference();
    },
    'light',
    oursRepeats
  );
}
