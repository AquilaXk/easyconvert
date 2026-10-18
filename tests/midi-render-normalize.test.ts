import { describe, expect, it } from 'vitest';
import { normalizeWavPeak } from '../src/lib/conversions/midi-render';

/**
 * The peak normalisation of a rendered MIDI WAV. The expected samples are written out from the rule: one linear gain that puts
 * the loudest sample at -1 dBFS, which is floor(32768 * 10^(-1/20)) = 29204 in 16 bits, and none for a file already at or above it.
 */

const TARGET_PEAK = 29_204;
const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const HEADER_BYTES = 44;

/** A canonical 44-byte-header stereo WAV of 16-bit samples at 44.1 kHz. */
function wavOf(samples: number[], format = FORMAT_PCM): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((value, i) => data.writeInt16LE(value, i * 2));
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(44_100, 24);
  header.writeUInt32LE(44_100 * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function samplesOf(wav: Buffer): number[] {
  return Array.from({ length: (wav.length - HEADER_BYTES) / 2 }, (_, i) => wav.readInt16LE(HEADER_BYTES + i * 2));
}

describe('normalizeWavPeak', () => {
  it('applies one linear gain that puts the loudest sample at 29204, keeping sign, shape and the header', () => {
    const input = wavOf([1000, -3000, 1500, 0, -750, 2999]);
    const output = normalizeWavPeak(input);
    expect(samplesOf(output)).toEqual([9735, -TARGET_PEAK, 14602, 0, -7301, 29_194]);
    expect(output.subarray(0, HEADER_BYTES)).toEqual(input.subarray(0, HEADER_BYTES));
    expect(output.length).toBe(input.length);
  });

  it('reads the peak of either channel and of a negative extreme', () => {
    expect(samplesOf(normalizeWavPeak(wavOf([100, 4000, -200, 0])))).toEqual([730, TARGET_PEAK, -1460, 0]);
  });

  it('leaves a file whose peak is already at or above -1 dBFS unchanged, to the byte', () => {
    for (const peak of [TARGET_PEAK, 30_000, 32_767, -32_768]) {
      const input = wavOf([100, peak, -50, 0]);
      expect(normalizeWavPeak(input).equals(input), `peak ${peak}`).toBe(true);
    }
  });

  it('leaves a silent file and a layout it does not read unchanged, to the byte', () => {
    const silent = wavOf([0, 0, 0, 0]);
    const float = wavOf([1000, -3000], FORMAT_FLOAT);
    const text = Buffer.from('not a wave file at all, nothing to scale');
    expect(normalizeWavPeak(silent).equals(silent)).toBe(true);
    expect(normalizeWavPeak(float).equals(float)).toBe(true);
    expect(normalizeWavPeak(text).equals(text)).toBe(true);
  });

  it('finds the samples after a chunk that sits between the format and the data', () => {
    const plain = wavOf([1000, -3000, 1500, 0]);
    // A LIST chunk of 4 bytes after the 16-byte fmt chunk, as an encoder writes its metadata: the data moves by 12 bytes.
    const list = Buffer.concat([Buffer.from('LIST', 'latin1'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO', 'latin1')]);
    const fmtEnd = 36;
    const input = Buffer.concat([plain.subarray(0, fmtEnd), list, plain.subarray(fmtEnd)]);
    input.writeUInt32LE(input.length - 8, 4);
    const output = normalizeWavPeak(input);
    const dataStart = fmtEnd + list.length + 8;
    const samples = Array.from({ length: 4 }, (_, i) => output.readInt16LE(dataStart + i * 2));
    expect(samples).toEqual([9735, -TARGET_PEAK, 14602, 0]);
    expect(output.subarray(0, dataStart)).toEqual(input.subarray(0, dataStart));
  });

  it('never writes a sample above the target for any gain: a peak of 1 is scaled to 29204', () => {
    expect(samplesOf(normalizeWavPeak(wavOf([1, -1, 0, 1])))).toEqual([TARGET_PEAK, -TARGET_PEAK, 0, TARGET_PEAK]);
  });
});
