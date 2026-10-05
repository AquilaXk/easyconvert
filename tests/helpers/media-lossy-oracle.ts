import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * Independent oracles for lossy media outputs: reference FFmpeg/FFprobe decoding, a best-lag SNR
 * measure against the source signal, and separately authored AAC fixtures. Nothing here imports
 * the conversion engines under test.
 */

export const BYTES_PER_SAMPLE = 2;
const WAV_HEADER_BYTES = 44;
const SOURCE_FREQUENCY_HZ = 440;
const SOURCE_PEAK = 12000;
const MAX_CODEC_DELAY_SAMPLES = 2600;
/** Trailing padding a lossy codec may add past the source length (two 1152-sample MP3 frames). */
const MAX_CODEC_PADDING_SAMPLES = 2304;
/** A decode whose frame count differs from the source by more than this is not the source. */
const MAX_FRAME_COUNT_DRIFT = MAX_CODEC_DELAY_SAMPLES + MAX_CODEC_PADDING_SAMPLES;
const CHIRP_START_HZ = 200;
const CHIRP_END_HZ = 4000;
/** Per-channel start offset, incommensurate with the sweep so channels never coincide. */
const CHIRP_CHANNEL_OFFSET_HZ = 137;
const EDGE_GUARD_SAMPLES = 4096;
const DECODE_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** ISO/IEC 14496-3 Table 1.18 sampling_frequency_index order. */
const ADTS_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
const ADTS_HEADER_BYTES = 7;
const ADTS_MAX_FRAME_BYTES = 0x1fff;

function requireTool(tool: 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(tool);
  if (!found) throw new Error(`${tool} oracle missing`);
  return found;
}

/** Interleaved sine; channel c is scaled by 1 / (c + 1) so stereo channels differ. */
export function sineSamples(sampleRate: number, channels: number, seconds: number): Int16Array {
  const frames = Math.round(sampleRate * seconds);
  const out = new Int16Array(frames * channels);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      out[i * channels + c] = Math.round(
        (Math.sin((2 * Math.PI * SOURCE_FREQUENCY_HZ * i) / sampleRate) * SOURCE_PEAK) / (c + 1)
      );
    }
  }
  return out;
}

/**
 * Interleaved linear chirp, 200 Hz to 4 kHz over the clip. It never repeats, so a delayed or
 * re-synthesized copy cannot align with it at any lag, and each channel sweeps from its own
 * start frequency so the channels are mutually distinct.
 */
export function chirpSamples(sampleRate: number, channels: number, seconds: number): Int16Array {
  const frames = Math.round(sampleRate * seconds);
  const out = new Int16Array(frames * channels);
  const sweepRate = (CHIRP_END_HZ - CHIRP_START_HZ) / seconds;
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    for (let c = 0; c < channels; c++) {
      const startHz = CHIRP_START_HZ + c * CHIRP_CHANNEL_OFFSET_HZ;
      const phase = 2 * Math.PI * (startHz * t + (sweepRate * t * t) / 2);
      out[i * channels + c] = Math.round(Math.sin(phase) * SOURCE_PEAK);
    }
  }
  return out;
}

export type RawWavEncoding = 'u8' | 's24' | 's32' | 'f32' | 'f64';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
/** Low byte stamped into every widened integer sample so truncating to 16 bits loses information. */
const WIDENED_LOW_BYTE = 0x5a;

/**
 * Hand-authored RIFF WAV carrying the 16-bit samples re-expressed in another sample format:
 * unsigned 8-bit, signed 24/32-bit PCM (with nonzero low bits), or IEEE float 32/64.
 */
export function wavWithEncoding(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  encoding: RawWavEncoding
): Buffer {
  const widths: Record<RawWavEncoding, number> = { u8: 1, s24: 3, s32: 4, f32: 4, f64: 8 };
  const bytesPerSample = widths[encoding];
  const data = Buffer.alloc(samples.length * bytesPerSample);
  samples.forEach((v, i) => {
    const at = i * bytesPerSample;
    if (encoding === 'u8') data.writeUInt8((v >> 8) + 128, at);
    else if (encoding === 's24') data.writeIntLE((v << 8) | WIDENED_LOW_BYTE, at, 3);
    else if (encoding === 's32') data.writeInt32LE((v << 16) | (WIDENED_LOW_BYTE << 8), at);
    else if (encoding === 'f32') data.writeFloatLE(v / 32768, at);
    else data.writeDoubleLE(v / 32768, at);
  });
  const isFloat = encoding === 'f32' || encoding === 'f64';
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(isFloat ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export function wavFromSamples(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataSize = samples.length * BYTES_PER_SAMPLE;
  const buf = Buffer.alloc(WAV_HEADER_BYTES + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28);
  buf.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i], WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE);
  }
  return buf;
}

export function withTempFile<T>(buffer: Buffer, extension: string, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-lossy-'));
  const file = path.join(dir, `in.${extension}`);
  try {
    fs.writeFileSync(file, buffer);
    return run(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs the reference FFmpeg over a buffer and returns raw stdout. */
export function ffmpegDecodeRaw(buffer: Buffer, extension: string, outputArgs: string[]): Buffer {
  return withTempFile(buffer, extension, (file) =>
    execFileSync(requireTool('ffmpeg'), ['-v', 'error', '-i', file, ...outputArgs, '-'], {
      maxBuffer: DECODE_MAX_BUFFER_BYTES,
    })
  );
}

/** Decodes any audio file with the reference FFmpeg into interleaved s16le at the given layout. */
export function decodeAudioWithFfmpeg(
  buffer: Buffer,
  extension: string,
  sampleRate: number,
  channels: number
): Int16Array {
  const raw = ffmpegDecodeRaw(buffer, extension, [
    '-f', 's16le',
    '-ac', String(channels),
    '-ar', String(sampleRate),
  ]);
  const out = new Int16Array(Math.floor(raw.length / BYTES_PER_SAMPLE));
  for (let i = 0; i < out.length; i++) out[i] = raw.readInt16LE(i * BYTES_PER_SAMPLE);
  return out;
}

/** Returns the FFprobe fields of the first stream of the requested kind. */
export function probeStream(buffer: Buffer, extension: string, kind: 'a' | 'v'): Record<string, string> {
  const text = withTempFile(buffer, extension, (file) =>
    execFileSync(
      requireTool('ffprobe'),
      [
        '-v', 'error',
        '-select_streams', kind,
        '-show_entries', 'stream=codec_name,sample_rate,channels,width,height',
        '-of', 'default=noprint_wrappers=1',
        file,
      ],
      { encoding: 'utf8' }
    )
  );
  const fields: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return fields;
}

/**
 * Best-lag SNR in dB of `decoded` against the source, tolerant of codec delay. Every channel is
 * scored at the same lag and the weakest channel decides, so a decode whose channels are
 * swapped, duplicated or silent cannot pass on the strength of channel 0. A decode whose frame
 * count differs from the source by more than the codec delay plus padding is not the source and
 * scores -Infinity, so truncated output cannot pass by matching only its prefix.
 */
export function bestSnrDb(reference: Int16Array, decoded: Int16Array, channels: number): number {
  const refFrames = Math.floor(reference.length / channels);
  const decFrames = Math.floor(decoded.length / channels);
  if (Math.abs(decFrames - refFrames) > MAX_FRAME_COUNT_DRIFT) return -Infinity;
  let best = -Infinity;
  for (let lag = 0; lag <= MAX_CODEC_DELAY_SAMPLES; lag++) {
    const end = Math.min(refFrames, decFrames - lag) - EDGE_GUARD_SAMPLES;
    if (end <= EDGE_GUARD_SAMPLES) break;
    let weakest = Infinity;
    for (let c = 0; c < channels; c++) {
      let signal = 0;
      let noise = 0;
      for (let i = EDGE_GUARD_SAMPLES; i < end; i++) {
        const r = reference[i * channels + c];
        const d = decoded[(i + lag) * channels + c];
        signal += r * r;
        noise += (r - d) * (r - d);
      }
      const snr = noise === 0 ? Infinity : 10 * Math.log10(signal / noise);
      if (snr < weakest) weakest = snr;
    }
    if (weakest > best) best = weakest;
  }
  return best;
}

/** Minimal MSB-first bit packer, authored here so the fixtures do not depend on the engine. */
class FixtureBits {
  private bits: number[] = [];

  write(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  toBuffer(): Buffer {
    const out = Buffer.alloc(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

const ID_SCE = 0;
const ID_CPE = 1;
const ID_END = 7;
const ZERO_HCB = 0;
const FIXTURE_GLOBAL_GAIN = 100;
const SECT_LEN_BITS = 5;

/** One channel's individual_channel_stream tail: gain, a single ZERO_HCB section, no tools. */
function writeSilentChannelTail(bits: FixtureBits, maxSfb: number): void {
  bits.write(FIXTURE_GLOBAL_GAIN, 8);
  bits.write(ZERO_HCB, 4);
  bits.write(maxSfb, SECT_LEN_BITS);
  bits.write(0, 3); // pulse_data_present, tns_data_present, gain_control_data_present
}

/** ics_info: reserved bit, ONLY_LONG_SEQUENCE, sine window, max_sfb, no predictor data. */
function writeIcsInfo(bits: FixtureBits, maxSfb: number): void {
  bits.write(0, 1);
  bits.write(0, 2);
  bits.write(0, 1);
  bits.write(maxSfb, 6);
  bits.write(0, 1);
}

/**
 * ISO/IEC 14496-3 raw_data_block whose every scalefactor band uses ZERO_HCB, so a conformant
 * decoder reproduces 1024 samples of silence per channel. maxSfb must fit one section length;
 * `terminator` overrides the 3-bit ID_END marker to author deliberately corrupt blocks.
 */
export function silentRawDataBlock(channels: 1 | 2, maxSfb = 4, terminator = ID_END): Buffer {
  const bits = new FixtureBits();
  if (channels === 1) {
    bits.write(ID_SCE, 3);
    bits.write(0, 4); // element_instance_tag
    bits.write(FIXTURE_GLOBAL_GAIN, 8);
    writeIcsInfo(bits, maxSfb);
    bits.write(ZERO_HCB, 4);
    bits.write(maxSfb, SECT_LEN_BITS);
    bits.write(0, 3);
  } else {
    bits.write(ID_CPE, 3);
    bits.write(0, 4); // element_instance_tag
    bits.write(1, 1); // common_window
    writeIcsInfo(bits, maxSfb);
    bits.write(0, 2); // ms_mask_present
    writeSilentChannelTail(bits, maxSfb);
    writeSilentChannelTail(bits, maxSfb);
  }
  bits.write(terminator, 3);
  return bits.toBuffer();
}

/** Wraps raw_data_blocks into ADTS frames (MPEG-4, AAC LC, no CRC). */
export function adtsStream(blocks: Buffer[], sampleRate: number, channels: number): Buffer {
  const srIndex = ADTS_SAMPLE_RATES.indexOf(sampleRate);
  if (srIndex < 0) throw new Error(`no ADTS sampling_frequency_index for ${sampleRate} Hz`);
  const frames = blocks.map((block) => {
    const length = ADTS_HEADER_BYTES + block.length;
    if (length > ADTS_MAX_FRAME_BYTES) throw new Error('ADTS frame too large');
    const header = Buffer.alloc(ADTS_HEADER_BYTES);
    header[0] = 0xff;
    header[1] = 0xf1; // MPEG-4, layer 0, protection absent
    header[2] = (1 << 6) | (srIndex << 2) | ((channels >> 2) & 1); // AAC LC
    header[3] = ((channels & 3) << 6) | ((length >> 11) & 3);
    header[4] = (length >> 3) & 0xff;
    header[5] = ((length & 7) << 5) | 0x1f;
    header[6] = 0xfc;
    return Buffer.concat([header, block]);
  });
  return Buffer.concat(frames);
}

export interface TestVideoSpec {
  width: number;
  height: number;
  fps: number;
  seconds: number;
  /** Keyframe interval in frames. */
  gop: number;
  /** Place the moov box before mdat. */
  faststart: boolean;
}

/** Authors an H.264 MP4 with the reference FFmpeg: the independent fixture for demuxer tests. */
export function ffmpegTestVideoMp4(spec: TestVideoSpec): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-video-'));
  const out = path.join(dir, 'out.mp4');
  try {
    execFileSync(requireTool('ffmpeg'), [
      '-v', 'error', '-y',
      '-f', 'lavfi',
      '-i', `testsrc=size=${spec.width}x${spec.height}:rate=${spec.fps}:duration=${spec.seconds}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-bf', '0',
      '-g', String(spec.gop), '-keyint_min', String(spec.gop), '-sc_threshold', '0',
      ...(spec.faststart ? ['-movflags', '+faststart'] : []),
      out,
    ]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Counts the video packets the reference FFprobe finds in a container. */
export function countVideoPackets(buffer: Buffer, extension: string): number {
  const text = withTempFile(buffer, extension, (file) =>
    execFileSync(
      requireTool('ffprobe'),
      ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file],
      { encoding: 'utf8' }
    )
  );
  return Number(text.trim());
}

/** Top-level ISO BMFF box types in file order, read without the engine under test. */
export function topLevelBoxTypes(buffer: Buffer): string[] {
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    types.push(buffer.toString('ascii', offset + 4, offset + 8));
    if (size < 8) break;
    offset += size;
  }
  return types;
}

/** Copies a Buffer into a standalone ArrayBuffer (never a SharedArrayBuffer view). */
export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.length);
  new Uint8Array(copy).set(buffer);
  return copy;
}
