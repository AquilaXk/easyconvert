import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionQueueItem } from '../src/lib/types';

// The routing decision and the GPU boundary are replaced so each browser image tier can be driven in Node with
// canvas stubs; client-converter, pure-canvas and canvas-encoding are the code under test and are not mocked.
vi.mock('../src/lib/edge/tier-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/tier-router')>();
  return { ...actual, resolveConversionTier: vi.fn() };
});
vi.mock('../src/lib/edge/pipelines/webgpu-compute-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/pipelines/webgpu-compute-pipeline')>();
  return { ...actual, isWebGpuComputeSupported: vi.fn(() => true), executeWebGpuCompute: vi.fn() };
});

import { ClientEdgeEscalationError, tryProcessClientEdge } from '../src/lib/client-converter';
import { assertEncodedBlob, assertEncodedSignature, canvasMimeType, detectEncodedFormat } from '../src/lib/edge/canvas-encoding';
import { resolveConversionTier, type ConversionTier } from '../src/lib/edge/tier-router';
import { executeWebGpuCompute } from '../src/lib/edge/pipelines/webgpu-compute-pipeline';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { encodeBmpFromImageData } from '../src/lib/edge/pure/pure-canvas';
import { decodeRgba, SKIP_WITHOUT_MAGICK } from './helpers/imagemagick';

// ---------------------------------------------------------------------------------------------------------------
// A browser in miniature: the canvas encodes what the browser would, so each test chooses how the browser behaves.
// ---------------------------------------------------------------------------------------------------------------

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0];
const WEBP_BYTES = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
const GIF_BYTES = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0];

const IMAGE_WIDTH = 2;
const IMAGE_HEIGHT = 2;
/** The source pixel, RGBA: a saturated orange. */
const SOURCE_PIXEL = [200, 100, 50, 255];

interface BrowserBehaviour {
  /** What `toBlob(type)` returns; the default is a browser that encodes PNG, JPEG and WebP and falls back to PNG. */
  encode: (type: string) => Blob | null;
}

const honestBrowser: BrowserBehaviour['encode'] = (type) => {
  const known: Record<string, number[]> = { 'image/png': PNG_BYTES, 'image/jpeg': JPEG_BYTES, 'image/webp': WEBP_BYTES };
  return known[type] ? new Blob([new Uint8Array(known[type])], { type }) : new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' });
};

const state = {
  encode: honestBrowser,
  putImageData: [] as number[][],
  encodedTypes: [] as string[],
  smoothing: [] as Array<{ enabled: unknown; quality: unknown }>,
  blobs: [] as Blob[],
};

class FakeImageData {
  constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {}
}

class FakeCanvas {
  constructor(readonly width: number, readonly height: number) {}
  getContext() {
    const pixels = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set(SOURCE_PIXEL, i);
    const ctx = {
      imageSmoothingEnabled: true as unknown,
      imageSmoothingQuality: 'low' as unknown,
      fillStyle: '',
      globalCompositeOperation: 'source-over',
      fillRect: () => undefined,
      drawImage: () => {
        state.smoothing.push({ enabled: ctx.imageSmoothingEnabled, quality: ctx.imageSmoothingQuality });
      },
      getImageData: () => ({ data: pixels, width: this.width, height: this.height }),
      putImageData: (image: FakeImageData) => {
        state.putImageData.push([...image.data.subarray(0, 4)]);
        pixels.set(image.data);
      },
    };
    return ctx;
  }
  async convertToBlob({ type }: { type: string }) {
    state.encodedTypes.push(type);
    return state.encode(type);
  }
}

function item(overrides: Partial<ConversionQueueItem> & { options?: Record<string, unknown>; target: string }): ConversionQueueItem {
  const file = new File([new Uint8Array(PNG_BYTES)], 'in.png', { type: 'image/png' });
  return {
    id: 'edge-image',
    file,
    name: 'in.png',
    size: file.size,
    sourceFormat: 'png',
    targetFormat: overrides.target,
    status: 'ready',
    progress: 0,
    options: { ...(overrides.options ?? {}) } as ConversionQueueItem['options'],
  };
}

function routeTo(tier: ConversionTier): void {
  vi.mocked(resolveConversionTier).mockReturnValue({ tier, tierName: `edge ${tier}`, isClientEdge: true, reason: 'routed by test' });
}

async function failureOf(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call resolved but was expected to throw');
}

beforeEach(() => {
  state.encode = honestBrowser;
  state.putImageData = [];
  state.encodedTypes = [];
  state.smoothing = [];
  state.blobs = [];
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('createImageBitmap', async () => ({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, close: () => undefined }));
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal('ImageData', FakeImageData);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    state.blobs.push(blob as Blob);
    return `blob:edge-${state.blobs.length}`;
  });
  vi.mocked(executeWebGpuCompute).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('assertEncodedSignature', () => {
  it('recognises the signature of each format a canvas or the BMP encoder produces', () => {
    expect(detectEncodedFormat(new Uint8Array(PNG_BYTES))).toBe('png');
    expect(detectEncodedFormat(new Uint8Array(JPEG_BYTES))).toBe('jpeg');
    expect(detectEncodedFormat(new Uint8Array(WEBP_BYTES))).toBe('webp');
    expect(detectEncodedFormat(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('bmp');
    expect(detectEncodedFormat(new Uint8Array(GIF_BYTES))).toBeNull();
    // Each target accepts its own format only; jpg and jpeg are one format.
    expect(['png', 'jpg', 'jpeg', 'webp', 'bmp'].map((target) => {
      const bytes = { png: PNG_BYTES, jpg: JPEG_BYTES, jpeg: JPEG_BYTES, webp: WEBP_BYTES, bmp: [0x42, 0x4d, 0, 0] }[target] as number[];
      return assertEncodedSignature(new Uint8Array(bytes), target);
    })).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });

  it('refuses another format, an empty result and a target without a known signature, each as EdgeUnsupportedError', () => {
    // A browser that cannot encode WebP hands back a PNG.
    const substituted = (() => {
      try {
        assertEncodedSignature(new Uint8Array(PNG_BYTES), 'webp');
      } catch (error) {
        return error as Error;
      }
      throw new Error('PNG bytes were accepted as WebP');
    })();
    expect(substituted).toBeInstanceOf(EdgeUnsupportedError);
    expect(substituted.message).toBe('The browser produced an image that is not a .webp file (signature 89504e47); the server converts it.');
    expect(() => assertEncodedSignature(new Uint8Array(0), 'png')).toThrow(/no image data for \.png/);
    expect(() => assertEncodedSignature(new Uint8Array(GIF_BYTES), 'gif')).toThrow(EdgeUnsupportedError);
    // JPEG signature is three bytes; two of them are not enough.
    expect(() => assertEncodedSignature(new Uint8Array([0xff, 0xd8, 0x00]), 'jpg')).toThrow(EdgeUnsupportedError);
  });

  it('assertEncodedBlob also refuses a blob typed as another format', async () => {
    await expect(assertEncodedBlob(new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }), 'webp')).rejects.toThrow(
      /returned image\/png where image\/webp was requested/
    );
    await expect(assertEncodedBlob(new Blob([new Uint8Array(JPEG_BYTES)], { type: 'image/jpeg' }), 'jpg')).resolves.toBeUndefined();
  });

  it('canvasMimeType names the encodable targets and refuses the rest', () => {
    expect(['png', 'jpg', 'jpeg', 'webp'].map(canvasMimeType)).toEqual(['image/png', 'image/jpeg', 'image/jpeg', 'image/webp']);
    for (const target of ['gif', 'bmp', 'tiff', 'avif']) expect(() => canvasMimeType(target)).toThrow(EdgeUnsupportedError);
  });
});

describe('L2 (Wasm filters then canvas): the file is the format asked for, or the server converts it', () => {
  beforeEach(() => routeTo('L2'));

  it('applies the filter and returns real JPEG bytes for a .jpg target', async () => {
    const result = await tryProcessClientEdge(item({ target: 'jpg', options: { grayscale: true } }));
    expect(result?.tier).toBe('L2');
    // BT.601 luma of (200, 100, 50): 0.299 * 200 + 0.587 * 100 + 0.114 * 50 = 124.2.
    const [r, g, b, a] = state.putImageData[0];
    expect([r, g, b, a].map((value, index) => (index < 3 ? Math.round(value / 4) : value))).toEqual([31, 31, 31, 255]);
    expect(state.encodedTypes).toEqual(['image/jpeg']);
    expect([...new Uint8Array(await state.blobs[0].slice(0, 3).arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('writes a .bmp target with the BMP encoder, not a PNG under the BMP name', async () => {
    const result = await tryProcessClientEdge(item({ target: 'bmp', options: { invert: true } }));
    expect(result?.tier).toBe('L2');
    const bytes = new Uint8Array(await state.blobs[0].arrayBuffer());
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('BM');
    const view = new DataView(bytes.buffer);
    expect([view.getInt32(18, true), view.getInt32(22, true), view.getUint16(28, true)]).toEqual([IMAGE_WIDTH, IMAGE_HEIGHT, 24]);
    // First pixel, stored B, G, R: the inverted orange (55, 155, 205) in RGB.
    expect([bytes[54], bytes[55], bytes[56]]).toEqual([205, 155, 55]);
    expect(state.blobs[0].type).toBe('image/bmp');
    expect(state.encodedTypes).toEqual([]);
  });

  it('sends a .gif target to the server: the canvas cannot encode GIF and PNG is not GIF', async () => {
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'gif', options: { grayscale: true } })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect((failure as ClientEdgeEscalationError).fallbackFrom).toBe('L2');
    expect(failure.message).toBe('A browser canvas cannot encode .gif; the server converts it.');
    expect(state.blobs).toEqual([]);
  });

  it('sends the file to the server when the browser answers a WebP request with a PNG', async () => {
    state.encode = (type) => (type === 'image/webp' ? new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }) : honestBrowser(type));
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'webp', options: { grayscale: true } })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect(failure.message).toMatch(/returned image\/png where image\/webp was requested/);
    expect(state.blobs).toEqual([]);
  });

  it('sends the file to the server when the canvas encodes zero bytes', async () => {
    state.encode = () => new Blob([]);
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'png', options: { grayscale: true } })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect(failure.message).toBe('The canvas produced no image data for image/png.');
    expect(state.blobs).toEqual([]);
  });

  it('sends a resize with a filter to the server instead of dropping the requested size', async () => {
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'jpg', options: { grayscale: true, width: 1 } })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect(failure.message).toMatch(/resize/i);
    expect(state.blobs).toEqual([]);
  });
});

describe('L1A (WebGPU): a result needs a pixel task, and the file is the format asked for', () => {
  beforeEach(() => routeTo('L1A'));

  it('never turns an image grey just because the GPU was requested: with no pixel task the GPU is not run', async () => {
    const result = await tryProcessClientEdge(item({ target: 'jpg', options: { useWebGpu: true } }));
    expect(executeWebGpuCompute).not.toHaveBeenCalled();
    // The unmodified pixels are re-encoded by the next tier, which says so.
    expect(result?.tier).toBe('L2');
    expect(result?.fallbackFrom).toBe('L1A');
    expect(state.putImageData).toEqual([]);
    expect([...new Uint8Array(await state.blobs[0].slice(0, 3).arrayBuffer())]).toEqual([0xff, 0xd8, 0xff]);
  });

  it('runs the requested task on the GPU and returns the format asked for', async () => {
    vi.mocked(executeWebGpuCompute).mockImplementation(async ({ data }) => ({
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      data: new Uint8Array(data.length).fill(77),
    }));
    const result = await tryProcessClientEdge(item({ target: 'webp', options: { useWebGpu: true, invert: true } }));
    expect(vi.mocked(executeWebGpuCompute).mock.calls[0][0].task).toEqual({ type: 'color-transform', options: { mode: 'invert' } });
    expect(result?.tier).toBe('L1A');
    expect(state.putImageData[0]).toEqual([77, 77, 77, 77]);
    expect(state.blobs[0].type).toBe('image/webp');
    expect([...new Uint8Array(await state.blobs[0].slice(0, 4).arrayBuffer())]).toEqual([0x52, 0x49, 0x46, 0x46]);
  });

  it('sends a .gif target to the server after the GPU result, not a PNG named GIF', async () => {
    vi.mocked(executeWebGpuCompute).mockImplementation(async ({ data }) => ({ width: IMAGE_WIDTH, height: IMAGE_HEIGHT, data: new Uint8Array(data) }));
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'gif', options: { useWebGpu: true, grayscale: true } })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect(failure.message).toMatch(/cannot encode \.gif/);
    expect(state.blobs).toEqual([]);
  });
});

describe('L0 (pure canvas): the blob is the format asked for, and downscaling is smooth', () => {
  beforeEach(() => routeTo('L0'));

  it('labels the result with the type of the blob the browser returned', async () => {
    const result = await tryProcessClientEdge(item({ target: 'webp' }));
    expect(result?.tier).toBe('L0');
    expect(state.blobs[0].type).toBe('image/webp');
  });

  it('sends the file to the server when the browser substitutes a PNG for the requested WebP', async () => {
    state.encode = (type) => (type === 'image/webp' ? new Blob([new Uint8Array(PNG_BYTES)], { type: 'image/png' }) : honestBrowser(type));
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'webp' })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect((failure as ClientEdgeEscalationError).fallbackFrom).toBe('L0');
    expect(failure.message).toMatch(/returned image\/png where image\/webp was requested/);
  });

  it('sends the file to the server when the canvas yields an empty blob', async () => {
    state.encode = () => new Blob([]);
    const failure = await failureOf(tryProcessClientEdge(item({ target: 'png' })));
    expect(failure).toBeInstanceOf(ClientEdgeEscalationError);
    expect(failure.message).toMatch(/no image data/);
    expect(state.blobs).toEqual([]);
  });

  it('draws a resized image with high-quality smoothing', async () => {
    const result = await tryProcessClientEdge(item({ target: 'png', options: { width: 1 } }));
    expect(result?.tier).toBe('L0');
    expect(state.smoothing).toEqual([{ enabled: true, quality: 'high' }]);
  });
});

describe('the BMP the browser tiers write', () => {
  it.skipIf(SKIP_WITHOUT_MAGICK)('decodes in ImageMagick to the pixels it was given, with rows padded to four bytes', () => {
    // 3 x 2 pixels: a row of 3 pixels is 9 bytes, padded to 12, the case a hand-written encoder gets wrong.
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
      10, 20, 30, 255, 40, 50, 60, 255, 250, 240, 230, 255,
    ]);
    const decoded = decodeRgba(Buffer.from(encodeBmpFromImageData({ width: 3, height: 2, data: rgba })), 'bmp');
    expect([decoded.width, decoded.height]).toEqual([3, 2]);
    expect([...decoded.data]).toEqual([...rgba]);
  });
});

describe('WebGPU colour transform uniforms', () => {
  it.each([
    ['grayscale', 0],
    ['invert', 1],
    ['brightness', 2],
    ['sepia', 3],
  ] as const)('writes mode %s as %i', async (mode, expectedCode) => {
    // The module caches its device: a fresh copy per case, so each case drives its own device.
    vi.resetModules();
    const actual = await vi.importActual<typeof import('../src/lib/edge/pipelines/webgpu-compute-pipeline')>('../src/lib/edge/pipelines/webgpu-compute-pipeline');
    const writes: ArrayBuffer[] = [];
    const device = {
      createShaderModule: () => ({}),
      createBuffer: () => ({ destroy: () => undefined, mapAsync: async () => undefined, getMappedRange: () => new ArrayBuffer(16), unmap: () => undefined }),
      queue: { writeBuffer: (_buffer: unknown, _offset: number, data: ArrayBuffer) => writes.push(data), submit: () => undefined },
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginComputePass: () => ({ setPipeline: () => undefined, setBindGroup: () => undefined, dispatchWorkgroups: () => undefined, end: () => undefined }),
        copyBufferToBuffer: () => undefined,
        finish: () => ({}),
      }),
    };
    vi.stubGlobal('navigator', { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } });
    await actual.executeWebGpuCompute({ width: 2, height: 2, data: new Uint8Array(16), task: { type: 'color-transform', options: { mode } } });
    // The first write is the uniform block: width, height, mode (u32 at byte 8), parameter (f32 at byte 12).
    const uniform = new DataView(writes[0]);
    expect([uniform.getUint32(0, true), uniform.getUint32(4, true), uniform.getUint32(8, true)]).toEqual([2, 2, expectedCode]);
  });
});
