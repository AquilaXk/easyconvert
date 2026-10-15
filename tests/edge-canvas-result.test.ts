import { afterEach, describe, expect, it, vi } from 'vitest';
import { tryProcessClientEdge } from '../src/lib/client-converter';
import { canvasToBlob } from '../src/lib/edge/pipelines/canvas-blob';
import { ConversionFailedError, type ConversionQueueItem } from '../src/lib/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call resolved but was expected to throw');
}

describe('a canvas that yields no image is a failure, never an empty file (issue #480)', () => {
  it('throws ConversionFailedError when toBlob hands back null', async () => {
    const canvas = { toBlob: (callback: (blob: Blob | null) => void) => callback(null) };
    const error = await failureOf(canvasToBlob(canvas, 'image/jpeg', 0.9));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.message).toMatch(/canvas produced no image data/);
  });

  it('throws ConversionFailedError when the canvas encodes zero bytes', async () => {
    const canvas = { convertToBlob: async () => new Blob([]) };
    const error = await failureOf(canvasToBlob(canvas, 'image/png', 0.9));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error.message).toBe('The canvas produced no image data for image/png.');
  });

  it('passes the type and quality on and returns the encoded blob', async () => {
    const seen: Array<[string, number]> = [];
    const canvas = {
      toBlob: (callback: (blob: Blob | null) => void, type: string, quality: number) => {
        seen.push([type, quality]);
        callback(new Blob(['jpeg bytes'], { type }));
      },
    };
    const blob = await canvasToBlob(canvas, 'image/jpeg', 0.8);
    expect(seen).toEqual([['image/jpeg', 0.8]]);
    expect(await blob.text()).toBe('jpeg bytes');
  });

  it('prefers convertToBlob where the canvas has it', async () => {
    const canvas = { convertToBlob: async ({ type }: { type: string }) => new Blob(['offscreen'], { type }) };
    expect(await (await canvasToBlob(canvas, 'image/webp', 0.5)).text()).toBe('offscreen');
  });

  it('gives no L2 result when the canvas cannot encode the filtered image', async () => {
    const width = 2;
    const height = 2;
    class FakeImageData {
      constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
    }
    class FakeOffscreenCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        const pixels = new Uint8ClampedArray(width * height * 4).fill(200);
        return {
          drawImage: () => undefined,
          getImageData: () => ({ data: pixels, width, height }),
          putImageData: () => undefined,
        };
      }
      toBlob(callback: (blob: Blob | null) => void) {
        callback(null);
      }
    }
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('createImageBitmap', async () => ({ width, height, close: () => undefined }));
    vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
    vi.stubGlobal('ImageData', FakeImageData);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' });
    const item: ConversionQueueItem = {
      id: 'canvas-null',
      file,
      name: 'a.png',
      size: file.size,
      sourceFormat: 'png',
      targetFormat: 'jpg',
      status: 'ready',
      progress: 0,
      options: { grayscale: true } as ConversionQueueItem['options'],
    };
    // The tier gives up (null), so the server tier converts the file; it does not return an empty image.
    expect(await tryProcessClientEdge(item)).toBeNull();
  });
});
