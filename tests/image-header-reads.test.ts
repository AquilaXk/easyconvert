import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { selectFrames } from '../src/lib/conversions/image-frames';
import { assertEncodedImageWithinLimit } from '../src/lib/conversions/image-input-limits';
import { metadataOf, withHeader } from '../src/lib/conversions/image-metadata';

/**
 * The header of a picture is read once. The image library parses it again on every call and answers through its thread pool, so a
 * conversion that asked for it six times spent 0.5 ms of a 6 ms conversion on the same few bytes. The oracle is the library's own
 * answer for the same bytes.
 */

const SIDE = 48;

function rgb16Png(): Promise<Buffer> {
  const samples = new Uint16Array(SIDE * SIDE * 3);
  for (let i = 0; i < samples.length; i += 1) samples[i] = (i % 7 < 3 ? 51_000 : (i * 2654435761) >>> 16) & 0xffff;
  return sharp(samples, { raw: { width: SIDE, height: SIDE, channels: 3 } }).toColourspace('rgb16').png().toBuffer();
}

function animatedGif(): Promise<Buffer> {
  const frame = (shade: number): Buffer => Buffer.alloc(SIDE * SIDE * 3, shade);
  return sharp(Buffer.concat([frame(10), frame(200)]), { raw: { width: SIDE, height: SIDE * 2, channels: 3, pageHeight: SIDE } }).gif({ loop: 0 }).toBuffer();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('metadataOf', () => {
  it('asks the library once per pipeline, gives every caller the same answer, and asks again for another pipeline', async () => {
    const source = await rgb16Png();
    const pipeline = sharp(source);
    const ask = vi.spyOn(pipeline, 'metadata');
    const [first, second] = await Promise.all([metadataOf(pipeline), metadataOf(pipeline)]);
    expect(await metadataOf(pipeline)).toBe(first);
    expect(second).toBe(first);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(first).toEqual(await sharp(source).metadata());
    const other = sharp(source);
    const askOther = vi.spyOn(other, 'metadata');
    await metadataOf(other);
    expect(askOther).toHaveBeenCalledTimes(1);
  });

  it('does not keep a failure for the next pipeline', async () => {
    const broken = sharp(Buffer.from('not a picture at all'));
    await expect(metadataOf(broken)).rejects.toThrow();
    await expect(metadataOf(sharp(await rgb16Png()))).resolves.toMatchObject({ format: 'png', width: SIDE });
  });
});

describe('withHeader', () => {
  it('gives the pipeline the header it is handed, without asking the library', async () => {
    const source = await rgb16Png();
    const header = await sharp(source).metadata();
    const pipeline = sharp(source);
    const ask = vi.spyOn(pipeline, 'metadata');
    expect(withHeader(pipeline, header)).toBe(pipeline);
    expect(await metadataOf(pipeline)).toBe(header);
    expect(ask).not.toHaveBeenCalled();
  });

  it('leaves the pipeline to the library when it is handed no header', async () => {
    const source = await rgb16Png();
    const pipeline = withHeader(sharp(source), undefined);
    expect(await metadataOf(pipeline)).toEqual(await sharp(source).metadata());
  });
});

describe('assertEncodedImageWithinLimit', () => {
  it('returns the header it read', async () => {
    const source = await rgb16Png();
    expect(await assertEncodedImageWithinLimit(source)).toEqual(await sharp(source).metadata());
  });
});

describe('selectFrames with a header', () => {
  it('takes the header it is given instead of reading the bytes, and hands it on for a single-frame source', async () => {
    const source = await rgb16Png();
    const header = await sharp(source).metadata();
    const selection = await selectFrames(source, 'jpg', {}, null, header);
    expect(selection.metadata).toBe(header);
    expect(selection.source).toBe(source);
    expect(selection.input).toEqual({});
  });

  it('does not read the bytes when it is given the header: bytes the library cannot read give the same selection', async () => {
    const header = await sharp(await rgb16Png()).metadata();
    const unreadable = Buffer.from('this is not a picture');
    await expect(selectFrames(unreadable, 'jpg', {})).rejects.toThrow();
    await expect(selectFrames(unreadable, 'jpg', {}, null, header)).resolves.toMatchObject({ keepsAnimation: false, metadata: header });
  });

  it('reads the header itself when it is not given one, and still reports it for a single-frame source', async () => {
    const source = await rgb16Png();
    const selection = await selectFrames(source, 'jpg', {});
    expect(selection.metadata).toEqual(await sharp(source).metadata());
  });

  it('reports no header for an animation: a pipeline opened on its frames reports otherwise', async () => {
    const source = await animatedGif();
    const selection = await selectFrames(source, 'gif', {});
    expect(selection.keepsAnimation).toBe(true);
    expect(selection.metadata).toBeUndefined();
  });
});

describe('a conversion reads the header of the PNG once', () => {
  async function pngHeaderReads(target: string): Promise<number> {
    const proto = Object.getPrototypeOf(sharp()) as { metadata: (this: unknown) => Promise<{ format?: string }> };
    const original = proto.metadata;
    let reads = 0;
    const spy = vi.spyOn(proto, 'metadata').mockImplementation(async function (this: unknown) {
      const meta = await original.call(this);
      if (meta.format === 'png') reads += 1;
      return meta;
    });
    try {
      await convertImage(await rgb16Png(), target, { quality: 60 }, 'p.png', 'png');
    } finally {
      spy.mockRestore();
    }
    return reads;
  }

  it.each(['jpg', 'avif', 'webp'])('%s', async (target) => {
    expect(await pngHeaderReads(target)).toBe(1);
  });
});
