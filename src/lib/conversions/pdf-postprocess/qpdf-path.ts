import { resolveBinaryPath } from './utils';

/**
 * Locate the qpdf binary on the system or return null if unavailable.
 */
export function getQpdfBinaryPath(): string | null {
  const candidates = [
    '/usr/bin/qpdf',
    '/usr/local/bin/qpdf',
    '/opt/homebrew/bin/qpdf',
    '/opt/homebrew/opt/qpdf/bin/qpdf',
  ];
  return resolveBinaryPath('QPDF_PATH', candidates, 'qpdf');
}
