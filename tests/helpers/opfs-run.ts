import { vi } from 'vitest';
import { processOpfsStreaming } from '../../src/lib/edge/workers/opfs-vfs.worker';
import { createFakeOpfs, type FakeOpfs, type FakeOpfsConfig } from './opfs-fake';

export type OpfsRoute = 'chunk-fallback' | 'sync-access-handle';
export const OPFS_ROUTES: OpfsRoute[] = ['chunk-fallback', 'sync-access-handle'];

export interface OpfsRun {
  fake: FakeOpfs;
  bytes: Buffer;
  /** Largest single write the sync access handle saw (0 on the in-memory route). */
  maxWrite: number;
}

/**
 * Runs one conversion through processOpfsStreaming, either with no OPFS (the in-memory chunk route) or with an
 * in-memory OPFS whose sync access handles follow the platform contract. Callers unstub globals afterwards.
 */
export async function runOpfsConversion(
  route: OpfsRoute,
  source: string,
  target: string,
  input: Uint8Array,
  options?: Record<string, unknown>,
  config: FakeOpfsConfig & { maxOutputBytes?: number; jobId?: string; expectsFallback?: boolean } = {}
): Promise<OpfsRun> {
  const fake = createFakeOpfs(config);
  if (route === 'sync-access-handle') vi.stubGlobal('navigator', fake.navigator);
  const blob = new Blob([input as BlobPart]);
  const result = await processOpfsStreaming(
    {
      jobId: config.jobId ?? `job-${source}-${target}`,
      sourceFormat: source,
      targetFormat: target,
      totalSize: blob.size,
      options,
      maxOutputBytes: config.maxOutputBytes,
    },
    blob
  );
  const outBlob = result.blob ?? new Blob([result.buffer as ArrayBuffer]);
  if (route === 'sync-access-handle' && !config.expectsFallback && fake.writes.sizes.length === 0) {
    throw new Error('the conversion fell back to the in-memory path instead of the OPFS sync access handle');
  }
  return { fake, bytes: Buffer.from(await outBlob.arrayBuffer()), maxWrite: fake.writes.maxWrite };
}

/** Like runOpfsConversion, for a conversion expected to fail: the error it rejects with and the fake it ran on. */
export async function runOpfsFailure(
  route: OpfsRoute,
  source: string,
  target: string,
  input: Uint8Array,
  options?: Record<string, unknown>,
  config: FakeOpfsConfig & { maxOutputBytes?: number; jobId?: string } = {}
): Promise<{ error: Error; fake: FakeOpfs; jobId: string }> {
  const jobId = config.jobId ?? `job-${source}-${target}`;
  const fake = createFakeOpfs(config);
  if (route === 'sync-access-handle') vi.stubGlobal('navigator', fake.navigator);
  const blob = new Blob([input as BlobPart]);
  try {
    await processOpfsStreaming(
      { jobId, sourceFormat: source, targetFormat: target, totalSize: blob.size, options, maxOutputBytes: config.maxOutputBytes },
      blob
    );
  } catch (error) {
    return { error: error as Error, fake, jobId };
  }
  throw new Error('the conversion resolved but was expected to fail');
}

/** The error a conversion rejects with; a conversion that resolves is a test failure. */
export async function failure(conversion: Promise<unknown>): Promise<Error> {
  try {
    await conversion;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the conversion resolved but was expected to fail');
}
