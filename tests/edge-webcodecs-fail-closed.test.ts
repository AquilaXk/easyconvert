import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processWebCodecsConversion } from '../src/lib/edge/workers/webcodecs.worker';
import { convertWithWebCodecs } from '../src/lib/edge/pipelines/webcodecs-pipeline';
import {
  EdgeUnsupportedError,
  rehydrateWorkerError,
  serializeWorkerError,
} from '../src/lib/edge/workers/worker-errors';
import { ConversionFailedError } from '../src/lib/types';
import { installFakeWebCodecs, type FakePlatform } from './helpers/webcodecs-platform-fakes';

/** Hand-assembled inputs that the edge worker has no demuxer for. They are bytes, not oracle output. */
function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, out.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const KIB = 1024;
const MEDIA_PAYLOAD_BYTES = 4 * KIB;

function aviBytes(): Uint8Array {
  const body = concat(new TextEncoder().encode('AVI LIST'), new Uint8Array(4), new TextEncoder().encode('hdrlavih'), new Uint8Array(MEDIA_PAYLOAD_BYTES));
  const header = new Uint8Array(8);
  header.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(header.buffer).setUint32(4, body.byteLength, true);
  return concat(header, body);
}

function mkvBytes(): Uint8Array {
  const ebmlHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, ...new TextEncoder().encode('matroska')]);
  const segment = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  return concat(ebmlHeader, new Uint8Array(6), segment, new Uint8Array(MEDIA_PAYLOAD_BYTES).fill(0xa3));
}

const FTYP = box('ftyp', concat(new TextEncoder().encode('isom'), new Uint8Array(4), new TextEncoder().encode('isomiso2')));
const MDAT = box('mdat', new Uint8Array(MEDIA_PAYLOAD_BYTES).fill(0xaa));

function mp4WithoutMoov(): Uint8Array {
  return concat(FTYP, MDAT);
}

function mp4WithoutSampleTables(): Uint8Array {
  const mvhd = box('mvhd', new Uint8Array(100));
  return concat(FTYP, box('moov', mvhd), MDAT);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

const UNSUPPORTED_INPUTS: Array<{ name: string; sourceFormat: string; build: () => Uint8Array }> = [
  { name: 'AVI bytes', sourceFormat: 'avi', build: aviBytes },
  { name: 'MKV bytes', sourceFormat: 'mkv', build: mkvBytes },
  { name: 'MKV bytes declared as mp4', sourceFormat: 'mp4', build: mkvBytes },
  { name: 'an MP4 without a moov box', sourceFormat: 'mp4', build: mp4WithoutMoov },
  { name: 'an MP4 whose moov carries no sample tables', sourceFormat: 'mp4', build: mp4WithoutSampleTables },
  { name: 'an empty file', sourceFormat: 'mp4', build: () => new Uint8Array(0) },
];

describe('WebCodecs worker never synthesizes media (issue #479)', () => {
  let platform: FakePlatform;

  beforeEach(() => {
    platform = installFakeWebCodecs();
  });

  afterEach(() => {
    platform.restore();
    vi.restoreAllMocks();
  });

  describe.each(['webm', 'mp4'])('video target %s', (targetFormat) => {
    it.each(UNSUPPORTED_INPUTS)('rejects $name with EdgeUnsupportedError and encodes no frame', async ({ sourceFormat, build }) => {
      const outcome = await processWebCodecsConversion({
        jobId: 'unsupported-input',
        sourceFormat,
        targetFormat,
        fileBuffer: toArrayBuffer(build()),
        options: { width: 320, height: 240 },
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );

      expect(outcome).not.toHaveProperty('result');
      const { error } = outcome as { error: unknown };
      expect(error).toBeInstanceOf(EdgeUnsupportedError);
      expect((error as Error).name).toBe('EdgeUnsupportedError');
      expect(platform.encodedFrames).toHaveLength(0);
    });
  });

  describe.each(['aac', 'm4a', 'opus'])('audio target %s', (targetFormat) => {
    it.each([
      { name: 'a WAV-declared file that is not RIFF', sourceFormat: 'wav', build: () => new Uint8Array(512) },
      { name: 'AVI bytes', sourceFormat: 'avi', build: aviBytes },
      { name: 'an empty file', sourceFormat: 'wav', build: () => new Uint8Array(0) },
    ])('rejects $name with EdgeUnsupportedError and encodes no audio', async ({ sourceFormat, build }) => {
      const outcome = await processWebCodecsConversion({
        jobId: 'unsupported-audio-input',
        sourceFormat,
        targetFormat,
        fileBuffer: toArrayBuffer(build()),
        options: {},
      }).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );

      expect(outcome).not.toHaveProperty('result');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(EdgeUnsupportedError);
      expect(platform.audioDataEncoded).toHaveLength(0);
    });
  });

  it('rejects a target container the worker cannot write instead of defaulting to H.264 in MP4', async () => {
    const outcome = await processWebCodecsConversion({
      jobId: 'unknown-target',
      sourceFormat: 'mp4',
      targetFormat: 'flv',
      fileBuffer: toArrayBuffer(mp4WithoutMoov()),
      options: {},
    }).then(
      (result) => ({ result }),
      (error: unknown) => ({ error })
    );

    expect(outcome).not.toHaveProperty('result');
    expect((outcome as { error: unknown }).error).toBeInstanceOf(EdgeUnsupportedError);
  });

  it('keeps the typed error across the worker boundary', () => {
    const original = new EdgeUnsupportedError('no demuxer for AVI');
    const restored = rehydrateWorkerError(JSON.parse(JSON.stringify(serializeWorkerError(original))));

    expect(restored).toBeInstanceOf(EdgeUnsupportedError);
    expect(restored).toBeInstanceOf(ConversionFailedError);
    expect(restored.message).toBe('no demuxer for AVI');
  });

  describe('the pipeline that calls the worker', () => {
    it('rejects with EdgeUnsupportedError and hands out no result URL for AVI input', async () => {
      const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
      const file = new File([toArrayBuffer(aviBytes())], 'clip.avi', { type: 'video/x-msvideo' });

      const outcome = await convertWithWebCodecs(file, 'avi', 'mp4', {}).then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      );

      expect(outcome).not.toHaveProperty('result');
      expect((outcome as { error: unknown }).error).toBeInstanceOf(EdgeUnsupportedError);
      expect(createObjectUrl).not.toHaveBeenCalled();
    });
  });
});
