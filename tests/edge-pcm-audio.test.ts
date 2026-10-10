import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pcmBlockToAudioData } from '../src/lib/edge/media/pcm-audio';
import { processWebCodecsConversion } from '../src/lib/edge/workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { getOracleToolPath } from './helpers/differential-oracle';
import { aacLcSpecificConfig, runFfmpeg, sineInput } from './helpers/ffmpeg-media-fixtures';
import { oracleTest } from './helpers/oracle-test';
import { installFakeWebCodecs } from './helpers/webcodecs-platform-fakes';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

describe('pcmBlockToAudioData', () => {
  it('reads 16-bit little-endian samples', () => {
    const block = pcmBlockToAudioData('pcm-s16', Uint8Array.from([0x01, 0x00, 0xff, 0xff, 0x00, 0x80, 0xff, 0x7f]), 2);

    expect(block.format).toBe('s16');
    expect(block.frames).toBe(2);
    expect([...block.data]).toEqual([1, -1, -32768, 32767]);
  });

  it('widens 24-bit samples to 32 bits by shifting eight bits, keeping sign and full scale', () => {
    // 0x030201 -> 0x03020100; 0xFFFFFF (-1) -> -256; 0x800000 (min) -> -2^31; 0x7FFFFF (max) -> 0x7FFFFF00
    const bytes = Uint8Array.from([0x01, 0x02, 0x03, 0xff, 0xff, 0xff, 0x00, 0x00, 0x80, 0xff, 0xff, 0x7f]);
    const block = pcmBlockToAudioData('pcm-s24', bytes, 1);

    expect(block.format).toBe('s32');
    expect(block.frames).toBe(4);
    expect([...block.data]).toEqual([0x03020100, -256, -(2 ** 31), 0x7fffff00]);
  });

  it('reads 32-bit integer and float samples', () => {
    const ints = pcmBlockToAudioData('pcm-s32', Uint8Array.from([0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x80]), 1);
    expect(ints.format).toBe('s32');
    expect([...ints.data]).toEqual([0x12345678, -(2 ** 31)]);

    // IEEE 754 binary32: 1.5 = 0x3FC00000, -2 = 0xC0000000
    const floats = pcmBlockToAudioData('pcm-f32', Uint8Array.from([0x00, 0x00, 0xc0, 0x3f, 0x00, 0x00, 0x00, 0xc0]), 1);
    expect(floats.format).toBe('f32');
    expect([...floats.data]).toEqual([1.5, -2]);
  });

  it('reads a block that sits at an odd offset of a larger buffer', () => {
    const backing = Uint8Array.from([0xaa, 0x01, 0x00, 0x02, 0x00]);

    expect([...pcmBlockToAudioData('pcm-s16', backing.subarray(1), 1).data]).toEqual([1, 2]);
  });

  it.each([
    ['an unknown codec label', 'pcm-u8', Uint8Array.from([1, 2]), 1, /pcm-u8/],
    ['a compressed codec', 'mp4a.40.2', Uint8Array.from([1, 2]), 1, /mp4a/],
    ['a block that is not a whole number of frames', 'pcm-s16', Uint8Array.from([1, 2, 3]), 1, /whole number of frames/],
    ['an empty block', 'pcm-s16', new Uint8Array(0), 1, /whole number of frames/],
    ['no channels', 'pcm-s16', Uint8Array.from([1, 2]), 0, /whole number of frames/],
  ] as Array<[string, string, Uint8Array, number, RegExp]>)('throws for %s', (_name, codec, bytes, channels, message) => {
    expect(() => pcmBlockToAudioData(codec, bytes, channels)).toThrow(EdgeUnsupportedError);
    expect(() => pcmBlockToAudioData(codec, bytes, channels)).toThrow(message);
  });
});

const PCM_CASES: Array<{ codec: string; rawFormat: string; audioDataFormat: string }> = [
  { codec: 'pcm_s16le', rawFormat: 's16le', audioDataFormat: 's16' },
  { codec: 'pcm_s24le', rawFormat: 's32le', audioDataFormat: 's32' },
  { codec: 'pcm_s32le', rawFormat: 's32le', audioDataFormat: 's32' },
  { codec: 'pcm_f32le', rawFormat: 'f32le', audioDataFormat: 'f32' },
];

describe('the worker feeds the encoder the PCM of the WAV, sample for sample', () => {
  for (const c of PCM_CASES) {
    oracleTest(`${c.codec}: AudioData of format ${c.audioDataFormat} equals ffmpeg's raw decode`, ['ffmpeg', 'ffprobe'], async () => {
      const wav = runFfmpeg([...sineInput(48000, 1), '-ac', '2', '-c:a', c.codec, '-f', 'wav'], 'wav');
      const dir = mkdtempSync(path.join(os.tmpdir(), 'pcm-oracle-'));
      let expected: Buffer;
      try {
        const file = path.join(dir, 'in.wav');
        writeFileSync(file, wav);
        expected = execFileSync(getOracleToolPath('ffmpeg') as string, ['-v', 'error', '-i', file, '-f', c.rawFormat, '-'], {
          maxBuffer: 64 * 1024 * 1024,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      const platform = installFakeWebCodecs({
        audioDecoderConfig: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, description: aacLcSpecificConfig(48000, 2) },
      });
      try {
        await processWebCodecsConversion({
          jobId: 'pcm-oracle',
          sourceFormat: 'wav',
          targetFormat: 'aac',
          fileBuffer: toArrayBuffer(wav),
          options: {},
        });

        expect(platform.audioEncoderConfigures[0]).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
        expect(platform.audioDataEncoded.every((d) => d.format === c.audioDataFormat)).toBe(true);
        const fed = Buffer.concat(
          platform.audioDataEncoded.map((d) => {
            const data = d.data as ArrayBufferView;
            return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
          })
        );
        expect(fed).toEqual(expected);
        expect(platform.audioDataClosers.every((close) => close.mock.calls.length === 1)).toBe(true);
      } finally {
        platform.restore();
      }
    });
  }
});
