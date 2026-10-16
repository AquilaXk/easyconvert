import sharp, { type Sharp } from 'sharp';
import { vi } from 'vitest';
import { convertImage } from '../../src/lib/conversions/image';

/**
 * Native pipeline runs (`toBuffer`) a conversion makes, and how many of them read the PNG itself rather than pixels in memory. The
 * caller restores the mocks (`vi.restoreAllMocks`) in an `afterEach`.
 */
export async function pipelineRuns(source: Buffer, target: string, options: Record<string, unknown> = {}): Promise<{ all: number; pngReads: number }> {
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
  await convertImage(source, target, { quality: 70, ...options }, 'plain.png', 'png');
  vi.restoreAllMocks();
  return runs;
}
