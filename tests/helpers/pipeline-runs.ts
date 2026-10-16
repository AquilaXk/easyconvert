import sharp, { type Sharp } from 'sharp';
import { vi } from 'vitest';

/**
 * Native pipeline runs (`toBuffer`) that `convert` makes, and how many of them read the PNG `source` itself rather than pixels in
 * memory. The conversion is passed in by the test, so this helper imports no production module. The caller restores the mocks
 * (`vi.restoreAllMocks`) in an `afterEach`.
 */
export async function countPipelineRuns(source: Buffer, convert: () => Promise<unknown>): Promise<{ all: number; pngReads: number }> {
  const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })) as Sharp;
  const toBuffer = proto.toBuffer;
  const runs = { all: 0, pngReads: 0 };
  vi.spyOn(proto, 'toBuffer').mockImplementation(function (this: Sharp, ...args: unknown[]) {
    const input = (this as unknown as { options: { input: { buffer?: Buffer } } }).options.input;
    runs.all += 1;
    // A cloned pipeline holds a copy of the input, so the PNG is recognised by its bytes.
    if (input.buffer !== undefined && Buffer.from(input.buffer).equals(source)) runs.pngReads += 1;
    return (toBuffer as (...a: unknown[]) => Promise<unknown>).apply(this, args);
  } as never);
  await convert();
  vi.restoreAllMocks();
  return runs;
}
