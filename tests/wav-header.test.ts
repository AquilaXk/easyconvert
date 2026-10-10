import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWavPcmHeader, readWavPcmInfo, WAV_HEADER_SCAN_BYTES } from '../src/lib/conversions/wav-header';
import { probeMediaDuration } from '../src/lib/conversions/media';
import { probeAudioStreamCount } from '../src/lib/conversions/media-ffprobe';
import { craftWav, int16Bytes, sineSamples } from './helpers/wav-craft';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const DURATION_TOLERANCE_S = 1e-5;
const TEST_TIMEOUT_MS = 120_000;
const ODD_CHUNK_BYTES = 7;

function pcm16(frames: number, channels: number, rate: number): Uint8Array {
  return int16Bytes(sineSamples(frames, channels, rate, 440, 12000));
}

interface WavCase {
  name: string;
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
}

function wavCase(name: string, spec: Parameters<typeof craftWav>[0]): WavCase {
  return {
    name,
    bytes: craftWav(spec),
    sampleRate: spec.sampleRate,
    channels: spec.channels,
    bitsPerSample: spec.bitsPerSample,
    dataBytes: spec.data.length,
  };
}

const CASES: WavCase[] = [
  wavCase('mono 16-bit 8 kHz', { sampleRate: 8000, channels: 1, bitsPerSample: 16, data: pcm16(12_345, 1, 8000) }),
  wavCase('stereo 16-bit 44.1 kHz', { sampleRate: 44_100, channels: 2, bitsPerSample: 16, data: pcm16(44_100, 2, 44_100) }),
  wavCase('stereo 16-bit 48 kHz after an odd LIST chunk', {
    sampleRate: 48_000,
    channels: 2,
    bitsPerSample: 16,
    data: pcm16(30_000, 2, 48_000),
    before: [{ id: 'LIST', body: new Uint8Array(ODD_CHUNK_BYTES).fill(0x41) }],
  }),
  wavCase('24-bit 96 kHz mono', { sampleRate: 96_000, channels: 1, bitsPerSample: 24, data: new Uint8Array(96_000 * 3).fill(0x10) }),
  wavCase('float 32-bit stereo', { sampleRate: 32_000, channels: 2, bitsPerSample: 32, formatTag: 3, data: new Uint8Array(32_000 * 8).fill(0x3c) }),
  wavCase('chunks after the data', {
    sampleRate: 22_050,
    channels: 1,
    bitsPerSample: 16,
    data: pcm16(22_050, 1, 22_050),
    after: [{ id: 'id3 ', body: new Uint8Array(33) }],
  }),
];

function withTempFile<T>(bytes: Uint8Array, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'wav-header-'));
  try {
    const file = join(dir, 'in.wav');
    writeFileSync(file, bytes);
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('WAVE header reader', () => {
  it.each(CASES)('reads the format and the data size of $name', ({ bytes, sampleRate, channels, bitsPerSample, dataBytes }) => {
    const info = parseWavPcmHeader(bytes, bytes.length);
    expect(info).toEqual({
      sampleRate,
      channels,
      bitsPerSample,
      dataBytes,
      durationSeconds: Math.floor(dataBytes / (channels * (bitsPerSample / 8))) / sampleRate,
    });
  });

  it('reads an extensible format header by its sub-format', () => {
    const plain = craftWav({ sampleRate: 48_000, channels: 2, bitsPerSample: 16, data: pcm16(4800, 2, 48_000) });
    // Rewrite the 16-byte fmt chunk as the 40-byte extensible form: tag 0xFFFE, 22 extra bytes, sub-format PCM.
    const fmtOffset = 12;
    const head = plain.subarray(0, fmtOffset + 8);
    const fmtBody = new Uint8Array(40);
    fmtBody.set(plain.subarray(fmtOffset + 8, fmtOffset + 8 + 16), 0);
    const view = new DataView(fmtBody.buffer);
    view.setUint16(0, 0xfffe, true);
    view.setUint16(16, 22, true);
    view.setUint16(18, 16, true);
    view.setUint32(20, 3, true);
    view.setUint16(24, 1, true);
    const rest = plain.subarray(fmtOffset + 8 + 16);
    const bytes = new Uint8Array(head.length + fmtBody.length + rest.length);
    bytes.set(head, 0);
    new DataView(bytes.buffer).setUint32(fmtOffset + 4, 40, true);
    bytes.set(fmtBody, head.length);
    bytes.set(rest, head.length + fmtBody.length);
    const info = parseWavPcmHeader(bytes, bytes.length);
    expect(info?.sampleRate).toBe(48_000);
    expect(info?.channels).toBe(2);
    expect(info?.dataBytes).toBe(4800 * 4);
  });

  it('answers null for every file it cannot measure exactly', () => {
    const good = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: pcm16(1000, 1, 8000) });
    const adpcm = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, formatTag: 2, data: pcm16(1000, 1, 8000) });
    const unknownSize = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: pcm16(1000, 1, 8000), dataSizeField: 0xffffffff });
    const lying = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: pcm16(1000, 1, 8000), dataSizeField: 5000 });
    const empty = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(0) });
    const fractional = craftWav({ sampleRate: 8000, channels: 1, bitsPerSample: 16, data: new Uint8Array(1) });
    const widened = craftWav({
      sampleRate: 8000,
      channels: 1,
      bitsPerSample: 16,
      data: pcm16(1000, 1, 8000),
      before: [{ id: 'JUNK', body: new Uint8Array(WAV_HEADER_SCAN_BYTES) }],
    });
    const notRiff = good.slice();
    notRiff[0] = 0x58;
    const wrongAlign = good.slice();
    new DataView(wrongAlign.buffer).setUint16(12 + 8 + 12, 3, true);
    const outcomes = new Map<string, unknown>([
      ['a compressed format tag', parseWavPcmHeader(adpcm, adpcm.length)],
      ['an unknown data size', parseWavPcmHeader(unknownSize, unknownSize.length)],
      ['a data size beyond the file', parseWavPcmHeader(lying, lying.length - 2000)],
      ['an empty data chunk', parseWavPcmHeader(empty, empty.length)],
      ['less than one frame of data', parseWavPcmHeader(fractional, fractional.length)],
      ['a data chunk beyond the scanned prefix', parseWavPcmHeader(widened.subarray(0, WAV_HEADER_SCAN_BYTES), widened.length)],
      ['a file that is not RIFF', parseWavPcmHeader(notRiff, notRiff.length)],
      ['a wrong block alignment', parseWavPcmHeader(wrongAlign, wrongAlign.length)],
      ['too few bytes', parseWavPcmHeader(good.subarray(0, 11), 11)],
    ]);
    expect([...outcomes.entries()].filter(([, outcome]) => outcome !== null).map(([name]) => name)).toEqual([]);
    expect(parseWavPcmHeader(good, good.length)?.durationSeconds).toBe(1000 / 8000);
  });

  it('answers null for a missing file and for a file that is not a WAVE', () => {
    expect(readWavPcmInfo('/nonexistent/in.wav')).toBeNull();
    withTempFile(new Uint8Array(100).fill(7), (file) => {
      expect(readWavPcmInfo(file)).toBeNull();
    });
  });
});

describe('probes against ffprobe', () => {
  oracleTest(
    'the header duration and the stream count equal what ffprobe reports for every case',
    ['ffprobe'],
    () => {
      const ffprobe = getOracleToolPath('ffprobe')!;
      for (const item of CASES) {
        withTempFile(item.bytes, (file) => {
          const reported = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
          const streams = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'default=nw=1:nk=1', file], {
            encoding: 'utf8',
          })
            .trim()
            .split('\n').length;
          const info = readWavPcmInfo(file);
          expect(info, item.name).not.toBeNull();
          expect(Math.abs((info?.durationSeconds ?? 0) - Number.parseFloat(reported)), item.name).toBeLessThan(DURATION_TOLERANCE_S);
          expect(probeMediaDuration(file)).toBe(info?.durationSeconds);
          expect(probeAudioStreamCount(file, ffprobe as never), item.name).toBe(streams);
        });
      }
    },
    TEST_TIMEOUT_MS
  );
});

