/**
 * Runs once when the Next.js server starts. Loading the storage selection here makes a missing or
 * invalid STORAGE_DRIVER, endpoint, region, bucket or credential stop the server at startup
 * instead of failing the first request that touches storage.
 */
export async function register(): Promise<void> {
  // The import sits inside a positive NEXT_RUNTIME check so that the Edge compilation of this file
  // drops it; an early return does not, and the Edge bundler then rejects the `node:` imports.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/storage/selected-storage');
  }
}
