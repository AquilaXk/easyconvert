import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { convertArchive } from '../src/lib/conversions/archive';
import { DecompressionLimitError } from '../src/lib/types';

describe('Decompression bounds remaining', () => {
  it('bounds tar.gz decompression', async () => {
    const zeros = Buffer.alloc(501 * 1024 * 1024);
    const gzipped = zlib.gzipSync(zeros);
    
    let caughtErr: Error | undefined;
    try {
      await convertArchive(gzipped, 'tar.gz', 'zip', {}, 'test.tar.gz');
    } catch (e) {
      caughtErr = e as Error;
    }
    
    expect(caughtErr).toBeDefined();
    expect(caughtErr).toBeInstanceOf(DecompressionLimitError);
    expect((caughtErr as DecompressionLimitError).status).toBe(413);
  });
});
