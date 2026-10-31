import fs from 'node:fs';
import path from 'node:path';
import { getPrlimitCapability, getUnshareCapability } from '../../src/lib/security/process-sandbox';
import { DJVULIBRE_REQUIRED_PATCHES, isPatchedDjvulibre } from '../../src/worker/djvu-render';
import { getOracleToolPath } from './differential-oracle';

/**
 * The djvulibre build of scripts/install-djvulibre.sh, which installs the patches it was built with beside its programs
 * (<install-dir>/share/doc/djvulibre/patches, the stamp the worker checks), and the program of the distribution package, which a test
 * compares it with.
 */

/** Where the Debian and Ubuntu package `djvulibre-bin` installs `ddjvu`. */
export const DISTRIBUTION_DDJVU = '/usr/bin/ddjvu';

/** The `ddjvu` the oracles resolve when it is the patched build, or undefined for another build or none. */
export function patchedDdjvu(): string | undefined {
  const ddjvu = getOracleToolPath('ddjvu');
  return ddjvu !== null && isPatchedDjvulibre(ddjvu) ? ddjvu : undefined;
}

/** Whether a DjVu run can start here: the worker refuses one that cannot have a user namespace of its own and prlimit (Linux). */
export function djvuRunsCanStart(): boolean {
  return process.platform === 'linux' && getUnshareCapability().args.includes('-r') && getPrlimitCapability().available;
}

/** `root/bin`, for stand-ins of `ddjvu` and `djvused`, with the stamp of the patched build beside it. */
export function stampedBinDir(root: string): string {
  const patches = path.join(root, 'share', 'doc', 'djvulibre', 'patches');
  fs.mkdirSync(patches, { recursive: true });
  for (const name of DJVULIBRE_REQUIRED_PATCHES) fs.writeFileSync(path.join(patches, name), '');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  return bin;
}
