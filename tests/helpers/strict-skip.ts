import { existsSync } from 'node:fs';
import path from 'node:path';
import { OracleToolMissingError, isOracleToolAvailable, type ExternalOracleTool } from './differential-oracle';

/**
 * Conditions for `it.skipIf` / `describe.skipIf` that cannot pass silently. A suite that needs a tool, a service or a
 * fetched sample is skipped on a developer machine without it; under ORACLE_STRICT_MODE=1 (CI) the same absence
 * throws an OracleToolMissingError when the suite is collected, so the run fails instead of reporting skipped tests.
 */

export function isStrictMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORACLE_STRICT_MODE === '1';
}

/**
 * True when the caller should skip because `what` is not available. Under ORACLE_STRICT_MODE=1 an absent `what`
 * throws instead, so the suite fails by name.
 */
export function skipUnless(what: string, available: boolean): boolean {
  if (available) return false;
  if (isStrictMode()) {
    throw new OracleToolMissingError(what, `ORACLE_STRICT_MODE=1 requires ${what}, which is not available`);
  }
  return true;
}

/** `skipUnless` for command-line tools resolved the way the oracles resolve them. */
export function skipWithoutTools(...tools: ExternalOracleTool[]): boolean {
  const missing = tools.filter((tool) => !isOracleToolAvailable(tool));
  return skipUnless(missing.join(', '), missing.length === 0);
}

const RAW_SAMPLE_CACHE = path.join(__dirname, '..', 'fixtures', 'raw', '.cache');

/** `skipUnless` for the camera RAW samples `npm run fixtures:raw` fetches into the cache, named by format. */
export function skipWithoutRawSamples(...formats: string[]): boolean {
  const missing = formats.filter((format) => !existsSync(path.join(RAW_SAMPLE_CACHE, `${format}.${format}`)));
  return skipUnless(`the RAW sample(s) ${missing.join(', ')} (npm run fixtures:raw)`, missing.length === 0);
}
