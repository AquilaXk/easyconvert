import { execFileSync } from 'node:child_process';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * What util-linux unshare(1) says each option does, read from its own `--help` output. Used as the reference for
 * the isolation arguments the sandbox builds: an argument the real tool does not know, or one that means a
 * different namespace than intended, shows up here instead of in production.
 *
 * Returns option -> description for every spelling of an option, short and long: `-n` and `--net` both map to
 * "unshare network namespace".
 */
export function readUnshareOptionMeanings(): Map<string, string> {
  const binary = getOracleToolPath('unshare');
  if (!binary) throw new OracleToolMissingError('unshare');
  const help = execFileSync(binary, ['--help'], { encoding: 'utf-8' });
  const meanings = new Map<string, string>();
  for (const line of help.split('\n')) {
    // " -m, --mount[=<file>]      unshare mounts namespace" / " -f, --fork                fork before launching <program>"
    const match = /^ (-\w), (--[\w-]+)(?:\[?=?<[^>]*>\]?)?\s{2,}(\S.*)$/.exec(line);
    if (!match) continue;
    meanings.set(match[1], match[3]);
    meanings.set(match[2], match[3]);
  }
  return meanings;
}
