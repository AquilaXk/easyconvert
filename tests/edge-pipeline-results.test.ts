import { resolveObjectURL } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tessellator is replaced by a pass-through spy so one test can hand the CAD engine a broken mesh; every
// other call runs the real tessellator.
vi.mock('../src/lib/conversions/cad-nurbs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/conversions/cad-nurbs')>();
  return { ...actual, tessellateCadText: vi.fn(actual.tessellateCadText) };
});

import { tessellateCadText } from '../src/lib/conversions/cad-nurbs';
import type { ConversionQueueItem } from '../src/lib/types';
import { ConversionFailedError } from '../src/lib/types';
import { ClientEdgeEscalationError, executeItemConversion, tryProcessClientEdge } from '../src/lib/client-converter';
import { executeServerlessCloudFallback } from '../src/lib/edge/pipelines/fallback-pipeline';
import { streamConvertWithOpfs } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { walkWav } from './helpers/riff-walker';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';

const originalCreateObjectURL = URL.createObjectURL;
const CSV = 'id,name\n1,Alice\n2,Bob\n';
const TSV = 'id\tname\r\n1\tAlice\r\n2\tBob';

function withoutObjectUrls(): void {
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = undefined;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  vi.unstubAllGlobals();
});

async function blobOfUrl(url: string): Promise<Blob> {
  const blob = resolveObjectURL(url);
  if (!blob) throw new Error(`${url} does not resolve to a Blob`);
  return blob as unknown as Blob;
}

describe('no fabricated result URLs (issue #480)', () => {
  it('does not hand out a blob:mock URL from the OPFS pipeline when the runtime has no object URLs', async () => {
    withoutObjectUrls();
    const file = new File([CSV], 'a.csv', { type: 'text/csv' });
    const error = await streamConvertWithOpfs(file, 'csv', 'tsv').then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error?.message).toMatch(/result URL/);
  });

  it('does not hand out a blob:mock URL from the cloud fallback when the runtime has no object URLs', async () => {
    withoutObjectUrls();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['converted bytes']), { status: 200 }));
    const error = await executeServerlessCloudFallback(new Blob(['source']), 'pdf').then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error?.message).toMatch(/download URL/);
  });

  it('returns a real object URL for the converted bytes where the runtime has them', async () => {
    const file = new File([CSV], 'a.csv', { type: 'text/csv' });
    const result = await streamConvertWithOpfs(file, 'csv', 'tsv');
    expect(result.url.startsWith('blob:')).toBe(true);
    expect(result.url).not.toContain('mock');
    expect(await (await blobOfUrl(result.url)).text()).toBe(TSV);
    expect(result.size).toBe(TSV.length);
  });
});

describe('no input passthrough from the OPFS pipeline (issue #480)', () => {
  class FakeWorker {
    static reply: (message: { jobId: string }) => Record<string, unknown> = () => ({});
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(message: { jobId: string }): void {
      const reply = { jobId: message.jobId, ...FakeWorker.reply(message) };
      queueMicrotask(() => this.onmessage?.({ data: reply } as MessageEvent));
    }
    terminate(): void {}
  }

  beforeEach(() => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('Worker', FakeWorker);
  });

  it('fails when the worker completes with neither a blob nor a buffer, instead of returning the input file', async () => {
    FakeWorker.reply = () => ({ type: 'COMPLETED', outputSize: 0 });
    const file = new File([CSV], 'a.csv', { type: 'text/csv' });
    const error = await streamConvertWithOpfs(file, 'csv', 'tsv').then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error?.message).toMatch(/without producing an output/);
  });

  it('returns the worker output, and its own size, when it has one', async () => {
    FakeWorker.reply = () => ({ type: 'COMPLETED', outputSize: 3, blob: new Blob(['abc']) });
    const file = new File([CSV], 'a.csv', { type: 'text/csv' });
    const result = await streamConvertWithOpfs(file, 'csv', 'tsv');
    expect(await result.blob.text()).toBe('abc');
    expect(result.size).toBe(3);
  });

  it('rebuilds the typed error a worker reports', async () => {
    FakeWorker.reply = () => ({
      type: 'ERROR',
      message: 'refused',
      error: { name: 'EdgeUnsupportedError', message: 'the server engine converts this' },
    });
    const file = new File([CSV], 'a.csv', { type: 'text/csv' });
    const error = await streamConvertWithOpfs(file, 'csv', 'tsv').then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(EdgeUnsupportedError);
    expect(error?.message).toBe('the server engine converts this');
  });
});

describe('the L0 audio path keeps the source layout (issue #480)', () => {
  const FRAMES = 4_800;

  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  function audioItem(
    channels: number,
    rate: number,
    options: ConversionQueueItem['options'] = {}
  ): ConversionQueueItem {
    const wav = craftWav({
      sampleRate: rate,
      channels,
      bitsPerSample: 16,
      data: int16Bytes(sineSamples(FRAMES, channels, rate, 440, 8_000)),
    });
    const file = new File([wav as BlobPart], 'tone.wav', { type: 'audio/wav' });
    return {
      id: `audio-${channels}`,
      file,
      name: 'tone.wav',
      size: file.size,
      sourceFormat: 'wav',
      targetFormat: 'wav',
      status: 'ready',
      progress: 0,
      options,
    };
  }

  async function resultWav(item: ConversionQueueItem): Promise<ReturnType<typeof walkWav>> {
    const result = await tryProcessClientEdge(item);
    expect(result?.tier).toBe('L0');
    const blob = await blobOfUrl(result?.resultUrl as string);
    return walkWav(new Uint8Array(await blob.arrayBuffer()));
  }

  it('writes a mono file as mono when no channel layout is requested', async () => {
    const wav = await resultWav(audioItem(1, 48_000));
    expect([wav.channels, wav.sampleRate, wav.dataSize]).toEqual([1, 48_000, FRAMES * 2]);
  });

  it('writes a stereo file as stereo when no channel layout is requested', async () => {
    const wav = await resultWav(audioItem(2, 44_100));
    expect([wav.channels, wav.sampleRate, wav.dataSize]).toEqual([2, 44_100, FRAMES * 4]);
  });

  it('mixes stereo down to mono when mono is requested', async () => {
    const wav = await resultWav(audioItem(2, 44_100, { audioChannels: 'mono' }));
    expect([wav.channels, wav.dataSize]).toEqual([1, FRAMES * 2]);
  });

  it('mixes mono up to stereo when stereo is requested', async () => {
    const wav = await resultWav(audioItem(1, 44_100, { audioChannels: 'stereo' }));
    expect([wav.channels, wav.dataSize]).toEqual([2, FRAMES * 4]);
  });

  it('resamples to the requested rate', async () => {
    const wav = await resultWav(audioItem(1, 48_000, { audioSampleRate: 16_000 }));
    expect(wav.sampleRate).toBe(16_000);
    expect(Math.abs(wav.dataSize / 2 - FRAMES / 3)).toBeLessThanOrEqual(1);
  });

  it.each(['5.1', '7.1'] as const)('escalates a %s request to the server tier instead of relabelling the header', async (layout) => {
    const error = await tryProcessClientEdge(audioItem(2, 44_100, { audioChannels: layout })).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(ClientEdgeEscalationError);
    expect((error as ClientEdgeEscalationError).fallbackFrom).toBe('L0');
    expect(error?.message).toMatch(/cannot write/);
  });

  it('runs the server tier for what the L0 audio engine cannot mix, with the reason attached', async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();
    vi.stubGlobal('fetch', async () => new Response(new Blob(['server result']), { status: 200 }));
    await executeItemConversion(audioItem(2, 44_100, { audioChannels: '5.1' }), {
      onProgress: vi.fn(),
      onSuccess,
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    const [, , edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
    expect([edgeProcessed, tierName]).toEqual([false, 'Cloud (Zero-Retention)']);
    expect(fallback).toMatchObject({ fallbackFrom: 'L0', escalationReason: expect.stringMatching(/cannot write 5\.1/) });
  });
});

describe('the L0 CAD path hands a broken mesh to the server tier (issue #480)', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
  });

  function stepItem(): ConversionQueueItem {
    const file = new File(['ISO-10303-21;'], 'part.step', { type: 'model/step' });
    return {
      id: 'cad-dangling',
      file,
      name: 'part.step',
      size: file.size,
      sourceFormat: 'step',
      targetFormat: 'stl',
      status: 'ready',
      progress: 0,
      options: {},
    };
  }

  it('escalates from L0 with the reason when a face names a vertex that does not exist', async () => {
    vi.mocked(tessellateCadText).mockReturnValueOnce({
      name: 'part',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      normals: [],
      faces: [[0, 1, 3]],
    });
    const error = await tryProcessClientEdge(stepItem()).then(
      () => undefined,
      (caught: unknown) => caught as Error
    );
    expect(error).toBeInstanceOf(ClientEdgeEscalationError);
    expect((error as ClientEdgeEscalationError).fallbackFrom).toBe('L0');
    expect(error?.message).toMatch(/face 0 has vertex index 3, but the mesh has 3 vertices/);
  });
});
