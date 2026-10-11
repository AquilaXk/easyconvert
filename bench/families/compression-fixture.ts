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
  path: string;
  original: Buffer;
  tar: Buffer;
}

/** The single member of a tar, read with the system tar. */
export function tarMember(tar: Buffer, tarBin: string): Buffer {
  return runTool(tarBin, ['-xOf', '-'], { input: tar }).stdout;
}

export function assertSame(label: string, actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new OutputIntegrityError(`${label} does not decode to the original ${expected.length} bytes (got ${actual.length})`);
}

/** The corpus files joined into one member, and a reproducible tar of it. */
export function buildMixedFixture(ctx: FamilyContext, tarBin: string): MixedFixture {
  const dir = ctx.scratch('mixed');
  fs.mkdirSync(dir);
  const member = path.join(dir, MIXED_NAME);
  const original = Buffer.concat(MIXED_INPUT_FILES.map((file) => ctx.corpusBuffer(file)));
  fs.writeFileSync(member, original);
  const tarFile = ctx.scratch('mixed.tar');
  runTool(tarBin, ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', tarFile, '-C', dir, MIXED_NAME]);
  return { dir, path: member, original, tar: fs.readFileSync(tarFile) };
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
