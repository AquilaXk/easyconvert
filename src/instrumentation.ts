/**
 * Runs once when the Next.js server starts. Loading the storage selection here makes a missing or
 * invalid STORAGE_DRIVER, endpoint, region, bucket or credential stop the server at startup
 * instead of failing the first request that touches storage.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }
  await import('./lib/storage/selected-storage');
}
