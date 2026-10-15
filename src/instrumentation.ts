/**
 * Runs once when the Next.js server starts. It validates the configuration, then loads the storage selection,
 * so that a missing or malformed variable stops the server at startup (the process prints each failing variable
 * and its rule, then exits non-zero) instead of failing the first request that needs it. Storage selection adds
 * its own checks: driver, endpoint, region, bucket and credentials.
 */
export async function register(): Promise<void> {
  // The imports sit inside a positive NEXT_RUNTIME check so that the Edge compilation of this file
  // drops them; an early return does not, and the Edge bundler then rejects the `node:` imports.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { verifyWebConfiguration } = await import('./lib/config/web-startup');
    verifyWebConfiguration();
    await import('./lib/storage/selected-storage');
  }
}
