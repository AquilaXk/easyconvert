import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * Independent oracles for FLAC output (RFC 9639): a hand-written structural parser that walks
 * every frame bit by bit, plus drivers for the reference `flac`, `metaflac`, `ffmpeg` and
 * `ffprobe` binaries. Nothing here imports the encoder under test.
 */

const STREAM_MARKER = 'fLaC';
const STREAMINFO_PAYLOAD_BYTES = 34;
const METADATA_HEADER_BYTES = 4;
const SYNC_FIXED = 0xfff8;
const SYNC_VARIABLE = 0xfff9;
const CRC8_POLY = 0x07;
const CRC16_POLY = 0x8005;
const MAX_FRAMES = 1 << 20;
const MAX_UTF8_BYTES = 7;
const TOOL_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const TOOL_TIMEOUT_MS = 120_000;

export type FlacSubframeType = 'constant' | 'verbatim' | 'fixed' | 'lpc';

export interface FlacResidualInfo {
  /** 0 = Rice (4-bit parameters), 1 = Rice2 (5-bit parameters). */
  method: number;
  partitionOrder: number;
  parameters: number[];
  /** Escape partitions: raw bit width per escaped partition. */
  escapeWidths: number[];
  bits: number;
}

export interface FlacSubframeInfo {
  type: FlacSubframeType;
  order: number;
  wastedBits: number;
  bitsPerSample: number;
  precision?: number;
  shift?: number;
  coefficients?: number[];
  residual?: FlacResidualInfo;
  bits: number;
}

export interface FlacFrameInfo {
  offset: number;
  size: number;
  variableBlocking: boolean;
  blockSizeCode: number;
  blockSize: number;
  sampleRateCode: number;
  sampleRate: number | null;
  channelAssignment: number;
  sampleSizeCode: number;
  codedNumber: number;
  headerCrcOk: boolean;
  frameCrcOk: boolean;
  subframes: FlacSubframeInfo[];
}

export interface FlacStreamInfo {
  minBlockSize: number;
  maxBlockSize: number;
  minFrameSize: number;
  maxFrameSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  totalSamples: number;
  md5: string;
}

export interface FlacStructure {
  streamInfo: FlacStreamInfo;
  frames: FlacFrameInfo[];
}

function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x80 ? ((crc << 1) ^ CRC8_POLY) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function crc16(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ CRC16_POLY) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

class BitCursor {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readBits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byteIndex = this.pos >> 3;
      if (byteIndex >= this.bytes.length) throw new Error('FLAC reference parser: read past end');
      value = value * 2 + ((this.bytes[byteIndex] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  readSigned(count: number): number {
    const raw = this.readBits(count);
    return raw >= 2 ** (count - 1) ? raw - 2 ** count : raw;
  }

  skipUnary(): number {
    let zeros = 0;
    while (this.readBits(1) === 0) zeros++;
    return zeros;
  }

  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

function readUtf8Number(cursor: BitCursor): number {
  const first = cursor.readBits(8);
  let extra = 0;
  let value = 0;
  if (first < 0x80) {
    return first;
  } else if (first >= 0xfe) {
    extra = 6;
    value = 0;
  } else {
    let mask = 0x40;
    extra = 0;
    while (first & mask) {
      extra++;
      mask >>= 1;
    }
    if (extra === 0 || extra + 1 > MAX_UTF8_BYTES) throw new Error('FLAC reference parser: bad UTF-8 lead byte');
    value = first & (mask - 1);
  }
  for (let i = 0; i < extra; i++) {
    const cont = cursor.readBits(8);
    if ((cont & 0xc0) !== 0x80) throw new Error('FLAC reference parser: bad UTF-8 continuation byte');
    value = value * 64 + (cont & 0x3f);
  }
  return value;
}

const FIXED_BLOCK_SIZES: Record<number, number> = { 1: 192 };
for (let c = 2; c <= 5; c++) FIXED_BLOCK_SIZES[c] = 576 << (c - 2);
for (let c = 8; c <= 15; c++) FIXED_BLOCK_SIZES[c] = 256 << (c - 8);

const TABLE_SAMPLE_RATES: Record<number, number> = {
  1: 88200,
  2: 176400,
  3: 192000,
  4: 8000,
  5: 16000,
  6: 22050,
  7: 24000,
  8: 32000,
  9: 44100,
  10: 48000,
  11: 96000,
};

const SAMPLE_SIZE_BITS: Record<number, number> = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 };

function parseResidual(
  cursor: BitCursor,
  blockSize: number,
  predictorOrder: number
): FlacResidualInfo {
  const startBits = cursor.pos;
  const method = cursor.readBits(2);
  if (method > 1) throw new Error('FLAC reference parser: reserved residual coding method');
  const partitionOrder = cursor.readBits(4);
  const partitions = 1 << partitionOrder;
  if (blockSize % partitions !== 0) {
    throw new Error('FLAC reference parser: partition order does not divide the block size');
  }
  const paramBits = method === 0 ? 4 : 5;
  const escape = (1 << paramBits) - 1;
  const parameters: number[] = [];
  const escapeWidths: number[] = [];
  for (let p = 0; p < partitions; p++) {
    const samples = blockSize / partitions - (p === 0 ? predictorOrder : 0);
    if (samples < 0) throw new Error('FLAC reference parser: partition shorter than predictor order');
    const param = cursor.readBits(paramBits);
    parameters.push(param);
    if (param === escape) {
      const width = cursor.readBits(5);
      escapeWidths.push(width);
      cursor.pos += width * samples;
    } else {
      for (let s = 0; s < samples; s++) {
        cursor.skipUnary();
        cursor.pos += param;
      }
    }
  }
  return { method, partitionOrder, parameters, escapeWidths, bits: cursor.pos - startBits };
}

function parseSubframe(
  cursor: BitCursor,
  blockSize: number,
  channelBps: number
): FlacSubframeInfo {
  const startBits = cursor.pos;
  if (cursor.readBits(1) !== 0) throw new Error('FLAC reference parser: subframe pad bit set');
  const typeBits = cursor.readBits(6);
  let wastedBits = 0;
  if (cursor.readBits(1) === 1) wastedBits = cursor.skipUnary() + 1;
  const bps = channelBps - wastedBits;
  if (typeBits === 0) {
    cursor.readBits(bps);
    return { type: 'constant', order: 0, wastedBits, bitsPerSample: bps, bits: cursor.pos - startBits };
  }
  if (typeBits === 1) {
    cursor.pos += bps * blockSize;
    return { type: 'verbatim', order: 0, wastedBits, bitsPerSample: bps, bits: cursor.pos - startBits };
  }
  if (typeBits >= 8 && typeBits <= 12) {
    const order = typeBits - 8;
    cursor.pos += order * bps;
    const residual = parseResidual(cursor, blockSize, order);
    return { type: 'fixed', order, wastedBits, bitsPerSample: bps, residual, bits: cursor.pos - startBits };
  }
  if (typeBits >= 32) {
    const order = (typeBits & 0x1f) + 1;
    cursor.pos += order * bps;
    const precisionCode = cursor.readBits(4);
    if (precisionCode === 15) throw new Error('FLAC reference parser: forbidden coefficient precision');
    const precision = precisionCode + 1;
    const shift = cursor.readSigned(5);
    if (shift < 0) throw new Error('FLAC reference parser: negative LPC shift is forbidden');
    const coefficients: number[] = [];
    for (let i = 0; i < order; i++) coefficients.push(cursor.readSigned(precision));
    const residual = parseResidual(cursor, blockSize, order);
    return {
      type: 'lpc',
      order,
      wastedBits,
      bitsPerSample: bps,
      precision,
      shift,
      coefficients,
      residual,
      bits: cursor.pos - startBits,
    };
  }
  throw new Error(`FLAC reference parser: reserved subframe type ${typeBits}`);
}

/** Walks a complete FLAC stream and validates every checksum it meets. */
export function parseFlacStructure(buffer: Uint8Array): FlacStructure {
  if (Buffer.from(buffer.subarray(0, 4)).toString('ascii') !== STREAM_MARKER) {
    throw new Error('FLAC reference parser: missing fLaC marker');
  }
  const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 4;
  let streamInfo: FlacStreamInfo | null = null;
  for (;;) {
    const header = view[offset];
    const isLast = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length = view.readUIntBE(offset + 1, 3);
    const payload = offset + METADATA_HEADER_BYTES;
    if (type === 0) {
      if (length !== STREAMINFO_PAYLOAD_BYTES) throw new Error('FLAC reference parser: bad STREAMINFO length');
      const packed = view.readBigUInt64BE(payload + 10);
      streamInfo = {
        minBlockSize: view.readUInt16BE(payload),
        maxBlockSize: view.readUInt16BE(payload + 2),
        minFrameSize: view.readUIntBE(payload + 4, 3),
        maxFrameSize: view.readUIntBE(payload + 7, 3),
        sampleRate: Number(packed >> 44n),
        channels: Number((packed >> 41n) & 0x7n) + 1,
        bitsPerSample: Number((packed >> 36n) & 0x1fn) + 1,
        totalSamples: Number(packed & 0xfffffffffn),
        md5: view.subarray(payload + 18, payload + 34).toString('hex'),
      };
    }
    offset = payload + length;
    if (isLast) break;
  }
  if (!streamInfo) throw new Error('FLAC reference parser: no STREAMINFO block');

  const frames: FlacFrameInfo[] = [];
  while (offset < view.length) {
    if (frames.length >= MAX_FRAMES) throw new Error('FLAC reference parser: too many frames');
    const frameStart = offset;
    const cursor = new BitCursor(view);
    cursor.pos = frameStart * 8;
    const sync = cursor.readBits(16);
    if (sync !== SYNC_FIXED && sync !== SYNC_VARIABLE) {
      throw new Error(`FLAC reference parser: bad sync 0x${sync.toString(16)} at byte ${frameStart}`);
    }
    const blockSizeCode = cursor.readBits(4);
    const sampleRateCode = cursor.readBits(4);
    const channelAssignment = cursor.readBits(4);
    const sampleSizeCode = cursor.readBits(3);
    if (cursor.readBits(1) !== 0) throw new Error('FLAC reference parser: reserved header bit set');
    const codedNumber = readUtf8Number(cursor);
    let blockSize: number;
    if (blockSizeCode === 6) blockSize = cursor.readBits(8) + 1;
    else if (blockSizeCode === 7) blockSize = cursor.readBits(16) + 1;
    else if (blockSizeCode === 0) throw new Error('FLAC reference parser: reserved block size code');
    else blockSize = FIXED_BLOCK_SIZES[blockSizeCode];
    let sampleRate: number | null = null;
    if (sampleRateCode === 12) sampleRate = cursor.readBits(8) * 1000;
    else if (sampleRateCode === 13) sampleRate = cursor.readBits(16);
    else if (sampleRateCode === 14) sampleRate = cursor.readBits(16) * 10;
    else if (sampleRateCode === 15) throw new Error('FLAC reference parser: forbidden sample rate code');
    else if (sampleRateCode !== 0) sampleRate = TABLE_SAMPLE_RATES[sampleRateCode];
    const headerEnd = cursor.pos / 8;
    const storedCrc8 = cursor.readBits(8);
    const headerCrcOk = storedCrc8 === crc8(view, frameStart, headerEnd);

    let streamBps = streamInfo.bitsPerSample;
    if (sampleSizeCode !== 0) streamBps = SAMPLE_SIZE_BITS[sampleSizeCode];
    let channelCount = channelAssignment + 1;
    if (channelAssignment >= 8) channelCount = 2;
    if (channelAssignment > 10) throw new Error('FLAC reference parser: reserved channel assignment');
    const subframes: FlacSubframeInfo[] = [];
    for (let c = 0; c < channelCount; c++) {
      let bps = streamBps;
      const sideChannel =
        (channelAssignment === 8 && c === 1) ||
        (channelAssignment === 9 && c === 0) ||
        (channelAssignment === 10 && c === 1);
      if (sideChannel) bps++;
      subframes.push(parseSubframe(cursor, blockSize, bps));
    }
    cursor.align();
    const frameEnd = cursor.pos / 8;
    const storedCrc16 = cursor.readBits(16);
    const frameCrcOk = storedCrc16 === crc16(view, frameStart, frameEnd);
    offset = cursor.pos / 8;
    frames.push({
      offset: frameStart,
      size: offset - frameStart,
      variableBlocking: sync === SYNC_VARIABLE,
      blockSizeCode,
      blockSize,
      sampleRateCode,
      sampleRate,
      channelAssignment,
      sampleSizeCode,
      codedNumber,
      headerCrcOk,
      frameCrcOk,
      subframes,
    });
  }
  return { streamInfo, frames };
}

export function sha256Hex(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Little-endian signed PCM bytes of interleaved samples, the byte layout FLAC's MD5 covers. */
export function pcmLittleEndianBytes(samples: Int16Array | Int32Array, bytesPerSample: number): Buffer {
  const out = Buffer.alloc(samples.length * bytesPerSample);
  for (let i = 0; i < samples.length; i++) {
    out.writeIntLE(samples[i], i * bytesPerSample, bytesPerSample);
  }
  return out;
}

function requireTool(tool: 'flac' | 'metaflac' | 'ffmpeg' | 'ffprobe'): string {
  const found = getOracleToolPath(tool);
  if (!found) throw new Error(`${tool} oracle missing`);
  return found;
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flac-oracle-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export interface FlacTestResult {
  ok: boolean;
  stderr: string;
}

/** `flac -t`: decodes the whole stream and verifies frame CRCs and the STREAMINFO MD5. */
export function flacCliTest(stream: Uint8Array): FlacTestResult {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    fs.writeFileSync(file, stream);
    const result = spawnSync(requireTool('flac'), ['-t', '-s', file], {
      encoding: 'utf-8',
      timeout: TOOL_TIMEOUT_MS,
    });
    return { ok: result.status === 0, stderr: result.stderr };
  });
}

/** `flac -d` to raw little-endian signed PCM at the stream's own sample size. */
export function flacCliDecodeRaw(stream: Uint8Array): Buffer {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    const out = path.join(dir, 'out.raw');
    fs.writeFileSync(file, stream);
    execFileSync(
      requireTool('flac'),
      ['-d', '-s', '-f', '--force-raw-format', '--endian=little', '--sign=signed', '-o', out, file],
      { timeout: TOOL_TIMEOUT_MS }
    );
    return fs.readFileSync(out);
  });
}

/**
 * `flac -d` to WAV, returning the data chunk. Used for sample sizes the raw writer refuses
 * (12 and 20 bit): the WAV writer left-justifies them in a 16/24-bit container.
 */
export function flacCliDecodeWavData(stream: Uint8Array): Buffer {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    const out = path.join(dir, 'out.wav');
    fs.writeFileSync(file, stream);
    execFileSync(requireTool('flac'), ['-d', '-s', '-f', '-o', out, file], { timeout: TOOL_TIMEOUT_MS });
    const wav = fs.readFileSync(out);
    let offset = 12;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') return wav.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size & 1);
    }
    throw new Error('flac -d produced a WAV without a data chunk');
  });
}

/** Little-endian PCM bytes with each sample left-justified in a whole-byte container. */
export function leftJustifiedPcmBytes(samples: Int32Array, bitsPerSample: number): Buffer {
  const bytes = Math.ceil(bitsPerSample / 8);
  const shift = bytes * 8 - bitsPerSample;
  const out = Buffer.alloc(samples.length * bytes);
  for (let i = 0; i < samples.length; i++) out.writeIntLE(samples[i] * 2 ** shift, i * bytes, bytes);
  return out;
}

/** Size in bytes of `flac -<level>` run over raw little-endian signed PCM. */
export function flacCliEncodedSize(
  pcm: Uint8Array,
  options: { level: number; channels: number; bitsPerSample: number; sampleRate: number }
): number {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.raw');
    const out = path.join(dir, 'out.flac');
    fs.writeFileSync(file, pcm);
    execFileSync(
      requireTool('flac'),
      [
        `-${options.level}`,
        '-s',
        '-f',
        '--force-raw-format',
        '--endian=little',
        '--sign=signed',
        `--channels=${options.channels}`,
        `--bps=${options.bitsPerSample}`,
        `--sample-rate=${options.sampleRate}`,
        '-o',
        out,
        file,
      ],
      { timeout: TOOL_TIMEOUT_MS }
    );
    return fs.statSync(out).size;
  });
}

/** MD5 of the unencoded audio as recorded in the STREAMINFO block, read by metaflac. */
export function metaflacMd5(stream: Uint8Array): string {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    fs.writeFileSync(file, stream);
    return execFileSync(requireTool('metaflac'), ['--show-md5sum', file], {
      encoding: 'utf-8',
      timeout: TOOL_TIMEOUT_MS,
    }).trim();
  });
}

/** Decodes with ffmpeg to raw little-endian PCM of the given sample format (s16le, s32le). */
export function ffmpegDecodeRaw(stream: Uint8Array, format: 's16le' | 's32le'): Buffer {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    fs.writeFileSync(file, stream);
    return execFileSync(
      requireTool('ffmpeg'),
      ['-v', 'error', '-i', file, '-f', format, '-acodec', `pcm_${format}`, '-'],
      { maxBuffer: TOOL_MAX_BUFFER_BYTES, timeout: TOOL_TIMEOUT_MS }
    );
  });
}

/** ffprobe view of the container: sample rate, channels and duration as the demuxer sees them. */
export function ffprobeStream(stream: Uint8Array): { sampleRate: number; channels: number; samples: number } {
  return withTempDir((dir) => {
    const file = path.join(dir, 'in.flac');
    fs.writeFileSync(file, stream);
    const out = execFileSync(
      requireTool('ffprobe'),
      ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,duration_ts', '-of', 'json', file],
      { encoding: 'utf-8', timeout: TOOL_TIMEOUT_MS }
    );
    const info = (JSON.parse(out) as { streams: Array<Record<string, string | number>> }).streams[0];
    return {
      sampleRate: Number(info.sample_rate),
      channels: Number(info.channels),
      samples: Number(info.duration_ts),
    };
  });
}

/** Renders a lavfi source to raw interleaved s16le PCM with ffmpeg. */
export function ffmpegLavfiPcm(
  graph: string,
  options: { sampleRate: number; channels: number; extraInputs?: string[]; filterComplex?: string }
): Int16Array {
  const args = ['-v', 'error', '-f', 'lavfi', '-i', graph];
  for (const extra of options.extraInputs ?? []) args.push('-f', 'lavfi', '-i', extra);
  if (options.filterComplex) args.push('-filter_complex', options.filterComplex);
  args.push('-ar', String(options.sampleRate), '-ac', String(options.channels), '-f', 's16le', '-');
  const raw = execFileSync(requireTool('ffmpeg'), args, {
    maxBuffer: TOOL_MAX_BUFFER_BYTES,
    timeout: TOOL_TIMEOUT_MS,
  });
  const out = new Int16Array(raw.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = raw.readInt16LE(i * 2);
  return out;
}
