import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { decodeRawInThread } from '../src/worker/raw-decode-host';
import { EngineUnavailableError } from '../src/lib/types';

const WORKER_ENTRY_PATTERN = /raw-decode-worker\.(js|ts)$/;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('in-process RAW decode thread entry', () => {
  it('reports the decoder as unavailable when no thread entry exists on the deployment', async () => {
    const realExists = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      WORKER_ENTRY_PATTERN.test(String(candidate)) ? false : realExists(candidate)
    );
    const error = await decodeRawInThread('x3f', Buffer.from('FOVb')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineUnavailableError);
    expect((error as EngineUnavailableError).engineName).toBe('raw-decode-thread');
  });
});
