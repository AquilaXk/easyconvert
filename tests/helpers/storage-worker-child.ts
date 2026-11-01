import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A worker process for tests/upload-in-parts-shared-store.test.ts: it runs one job through the worker's own
 * `processNodeJob`, which reads the stored upload `storageKey` and stores the result, with an engine that only hashes
 * its input file and writes `resultBytes` bytes from `resultSeed` into its temporary directory. It prints what it saw.
 */

const [storageKey, jobId, resultBytesArg, resultSeedArg] = process.argv.slice(2);

function resultBytes(length: number, seed: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let offset = 0; offset < length; offset += 4) bytes.writeUInt32LE(((offset >>> 2) ^ seed) >>> 0, offset);
  return bytes;
}

async function main(): Promise<void> {
  const { processNodeJob } = await import('../../src/lib/queue/node-processor');
  const { Queue } = await import('../../src/lib/queue/bullmq-engine');
  const { storageProvider } = await import('../../src/lib/storage');
  let inputPath: string | undefined;
  let inputSha256: string | undefined;
  const engine = {
    name: 'storage-child-engine',
    async convert(input: Buffer | { inputPath?: string }) {
      inputPath = Buffer.isBuffer(input) ? undefined : input.inputPath;
      inputSha256 = crypto.createHash('sha256').update(inputPath ? fs.readFileSync(inputPath) : (input as Buffer)).digest('hex');
      const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'engine-out-')), 'result.bin');
      const bytes = resultBytes(Number(resultBytesArg), Number(resultSeedArg));
      fs.writeFileSync(outputPath, bytes);
      return { buffer: Buffer.alloc(0), size: bytes.length, mimeType: 'application/octet-stream', filename: 'result.bin', filePath: outputPath };
    },
  };
  const queue = new Queue<never, never>('storage-worker-child');
  const job = await queue.add(
    'convert',
    { jobId, originalFilename: 'big.bin', sourceFormat: 'bin', targetFormat: 'bin', fileSize: 1, options: {}, storageKey } as never,
    { jobId }
  );
  const result = await processNodeJob(job as never, engine as never, storageProvider);
  process.stdout.write(`${JSON.stringify({ inputPath, inputSha256, resultKey: (result as { resultKey: string }).resultKey })}\n`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  }
);
