import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { baseImageThreads, pinBaseImageThreads } from '../src/lib/conversions/image-threads';

const FIXTURE_PNG = path.resolve(__dirname, 'fixtures/sample.png');

function expectCacheDisabled(): void {
  const limits = sharp.cache();
  expect(limits.memory.max).toBe(0);
  expect(limits.files.max).toBe(0);
  expect(limits.items.max).toBe(0);
  expect(limits.items.current).toBe(0);
}

describe('pinBaseImageThreads disables the global libvips operation cache', () => {
  afterAll(() => {
    pinBaseImageThreads();
  });

  it('clears pre-existing sharp cache bounds to zero and pins base concurrency', () => {
    sharp.cache({ memory: 50, files: 20, items: 100 });
    expect(sharp.cache().items.max).toBe(100);
    expect(sharp.cache().memory.max).toBe(50);

    const concurrency = pinBaseImageThreads();

    expect(concurrency).toBe(baseImageThreads());
    expect(sharp.concurrency()).toBe(baseImageThreads());
    expectCacheDisabled();
  });

  it('produces valid WebP and JPEG one-shot outputs with global cache remaining disabled', async () => {
    pinBaseImageThreads();
    const input = fs.readFileSync(FIXTURE_PNG);

    const webp = await convertImage(input, 'webp', {}, 'sample.png', 'png');
    expect(webp.mimeType).toBe('image/webp');
    expect(webp.buffer.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(webp.buffer.subarray(8, 12).toString('ascii')).toBe('WEBP');
    expectCacheDisabled();

    const jpeg = await convertImage(input, 'jpg', {}, 'sample.png', 'png');
    expect(jpeg.mimeType).toBe('image/jpeg');
    expect(jpeg.buffer[0]).toBe(0xff);
    expect(jpeg.buffer[1]).toBe(0xd8);
    expect(jpeg.buffer[2]).toBe(0xff);
    expect(jpeg.buffer[jpeg.buffer.length - 2]).toBe(0xff);
    expect(jpeg.buffer[jpeg.buffer.length - 1]).toBe(0xd9);
    expectCacheDisabled();
  });
});
