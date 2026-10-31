import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';
import { haveFontTools } from './fontforge-tool';
import { skipUnless } from './strict-skip';

/**
 * libeot's `eot2ttf`, which the worker runs as a separate program to decompress the MicroType Express data of an EOT font, and fontTools,
 * the independent font library that judges what it wrote. A run that is not strict skips the suites that need them when they are absent;
 * under ORACLE_STRICT_MODE=1 the same absence fails the suite by name, so CI cannot pass without having decompressed an MTX font.
 * Importing this module points the worker at the program that was found, as EOT2TTF_PATH does in a deployment.
 */

const program = getOracleToolPath('eot2ttf');
if (program !== null) process.env.EOT2TTF_PATH ??= program;

/** True when eot2ttf is available (or skipping is not allowed, which throws instead). */
export const haveEot2ttf = !skipUnless('eot2ttf (libeot, scripts/install-libeot.sh; searched on PATH and in /usr/local/bin)', program !== null);

/** True when eot2ttf and fontTools are both available. */
export const haveMtxOracles = haveEot2ttf && haveFontTools;

/** What the program writes for `eot` when it is run directly on the file, with no part of the converter in between. */
export function eot2ttfDirect(eot: Buffer): Buffer {
  if (program === null) throw new Error('eot2ttf is not available');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eot2ttf-direct-'));
  try {
    const input = path.join(directory, 'font.eot');
    const output = path.join(directory, 'font.ttf');
    fs.writeFileSync(input, eot);
    execFileSync(program, [input, output], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60_000 });
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
