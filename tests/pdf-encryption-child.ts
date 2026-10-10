import fs from 'node:fs';

/**
 * Runs inspectPdfEncryption on one file in a fresh process and prints how it ended, how long it took and how far the
 * peak RSS rose during the call, so the peak belongs to the inspection alone.
 *
 *   node --import tsx pdf-encryption-child.ts <file>
 */
const KIB = 1024;

async function main(): Promise<void> {
  const [file] = process.argv.slice(2);
  const bytes = fs.readFileSync(file);
  const { inspectPdfEncryption } = await import('../src/lib/conversions/pdf-encryption');
  const rssBefore = process.resourceUsage().maxRSS * KIB;
  const started = performance.now();
  let error: { name: string; status?: number; message: string } | null = null;
  let info: unknown = null;
  try {
    info = inspectPdfEncryption(bytes);
  } catch (err) {
    const typed = err as { name?: string; status?: number; message?: string };
    error = { name: String(typed.name), status: typed.status, message: String(typed.message) };
  }
  const elapsedMs = performance.now() - started;
  const rssGrowthBytes = process.resourceUsage().maxRSS * KIB - rssBefore;
  process.stdout.write(`RESULT:${JSON.stringify({ error, info, elapsedMs, rssGrowthBytes })}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
