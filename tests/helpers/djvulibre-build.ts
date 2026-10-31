import fs from 'node:fs';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * The djvulibre build of scripts/install-djvulibre.sh, which installs the patches it was built with beside its programs
 * (<install-dir>/share/doc/djvulibre/patches), and the program of the distribution package, which a test compares it with.
 */

/** Where the Debian and Ubuntu package `djvulibre-bin` installs `ddjvu`. */
export const DISTRIBUTION_DDJVU = '/usr/bin/ddjvu';

/** The `ddjvu` the oracles resolve when it is the patched build, or undefined for another build or none. */
export function patchedDdjvu(): string | undefined {
  const ddjvu = getOracleToolPath('ddjvu');
  if (ddjvu === null) return undefined;
  const installed = fs.realpathSync(ddjvu);
  return fs.existsSync(path.join(path.dirname(installed), '..', 'share', 'doc', 'djvulibre', 'patches')) ? ddjvu : undefined;
}
