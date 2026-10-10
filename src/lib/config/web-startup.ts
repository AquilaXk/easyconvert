import { ConfigurationError, loadConfig } from './index';

/** Exit status of a process that refuses to start because its configuration is invalid. */
export const INVALID_CONFIGURATION_EXIT_CODE = 1;

/**
 * The web server's start-up configuration check, called from the Next.js `register` hook. Next.js logs an error
 * thrown from `register` and keeps serving, so a bad configuration would not stop the server; this prints the
 * ConfigurationError (variables and rules, never values) and exits instead.
 */
export function verifyWebConfiguration(): void {
  try {
    loadConfig(process.env, { role: 'web' });
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;
    console.error(`[config] ${error.message}`);
    process.exit(INVALID_CONFIGURATION_EXIT_CODE);
  }
}
