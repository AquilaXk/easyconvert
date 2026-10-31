import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getPrlimitCapability, getUnshareCapability } from '../../src/lib/security/process-sandbox';
import { DJVULIBRE_DIGESTS_FILE, DJVULIBRE_REQUIRED_PATCHES, isPatchedDjvulibre } from '../../src/worker/djvu-render';
import { getOracleToolPath } from './differential-oracle';

/**
 * The djvulibre build of scripts/install-djvulibre.sh, which installs the patches it was built with and the digests of its programs beside
 * them (<install-dir>/share/doc/djvulibre, the stamp the worker checks), and the program of the distribution package, which a test
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

const docDirOf = (bin: string): string => path.join(bin, '..', 'share', 'doc', 'djvulibre');

/** `root/bin`, for stand-ins of `ddjvu` and `djvused`, with the patches of the build beside it; `recordDigests` completes the stamp. */
export function stampedBinDir(root: string): string {
  const bin = path.join(root, 'bin');
  const patches = path.join(docDirOf(bin), 'patches');
  fs.mkdirSync(patches, { recursive: true });
  for (const name of DJVULIBRE_REQUIRED_PATCHES) fs.writeFileSync(path.join(patches, name), '');
  fs.mkdirSync(bin);
  return bin;
}

/** Records the SHA-256 of the real files of the `ddjvu` and `djvused` in `bin` beside the patches, in the lines of `sha256sum`, as the build does. */
export function recordDigests(bin: string): void {
  const lines = ['ddjvu', 'djvused']
    .filter((name) => fs.existsSync(path.join(bin, name)))
    .map((name) => `${createHash('sha256').update(fs.readFileSync(fs.realpathSync(path.join(bin, name)))).digest('hex')}  ${name}\n`);
  fs.writeFileSync(path.join(docDirOf(bin), DJVULIBRE_DIGESTS_FILE), lines.join(''));
}
