/**
 * A process entry for tests/config-startup.test.ts: it runs the same start-up step as the real entries
 * (`worker-startup` for the worker, `web-startup` for the server) and prints a few resolved
 * values, so the test can spawn it with a chosen environment and read the exit code, stdout and stderr.
 */

const ROLE_ARGUMENT_INDEX = 2;

async function main(): Promise<void> {
  const role = process.argv[ROLE_ARGUMENT_INDEX];
  if (role === 'worker') {
    const { workerConfig } = await import('../../src/lib/config/worker-startup');
    process.stdout.write(
      `${JSON.stringify({
        WORKER_CONCURRENCY: workerConfig.WORKER_CONCURRENCY,
        WORKER_MAX_JOBS: workerConfig.WORKER_MAX_JOBS,
        STORAGE_DRIVER: workerConfig.STORAGE_DRIVER,
        APP_URL: workerConfig.APP_URL ?? null,
      })}\n`
    );
    return;
  }
  if (role === 'web') {
    const { verifyWebConfiguration } = await import('../../src/lib/config/web-startup');
    const { loadConfig } = await import('../../src/lib/config');
    verifyWebConfiguration();
    const config = loadConfig(process.env, { role: 'web' });
    process.stdout.write(`${JSON.stringify({ STORAGE_DRIVER: config.STORAGE_DRIVER, APP_URL: config.APP_URL ?? null })}\n`);
    return;
  }
  throw new Error(`unknown role argument "${role}"`);
}

void main();
