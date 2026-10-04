import { isOracleToolAvailable } from './differential-oracle';

export const HAS_SOFFICE = isOracleToolAvailable('soffice');
export const HAS_PDFTOTEXT = isOracleToolAvailable('pdftotext');
export const HAS_PDFTOPPM = isOracleToolAvailable('pdftoppm');
export const HAS_PDFTOCAIRO = isOracleToolAvailable('pdftocairo');

/** A path that never resolves to a binary, so the worker engines treat the tool as not installed. */
const MISSING_BINARY_PATH = '/nonexistent/easyconvert-missing-binary';

/**
 * Runs `operation` while the worker engines see the binary behind `envVar` (for example
 * SOFFICE_PATH) as not installed, then restores the previous value. The engines resolve the
 * override on every conversion, so the absence is real for the engine, not a mock.
 */
export async function withMissingBinary<T>(envVar: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env[envVar];
  process.env[envVar] = MISSING_BINARY_PATH;
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env[envVar];
    } else {
      process.env[envVar] = previous;
    }
  }
}
