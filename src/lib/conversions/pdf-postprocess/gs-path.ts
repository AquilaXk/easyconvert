import { resolveBinaryPath } from './utils';

/**
 * Locate the Ghostscript `gs` binary on the system or return null if unavailable.
 */
export function getGhostscriptBinaryPath(): string | null {
  const candidates = ['/usr/bin/gs', '/usr/local/bin/gs', '/opt/homebrew/bin/gs'];
  return resolveBinaryPath('GS_PATH', candidates, 'gs');
}
