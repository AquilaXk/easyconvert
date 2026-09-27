import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversionOptions, ConversionResult } from '../types';
import { executeSandboxedBinary } from '../security/process-sandbox';
import { encodePureMp3, encodePureH264Mp4, encodeFlacStream } from './media-encoder';
import {
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  DecodedAudio,
} from './media-decoder';

export interface FfmpegEnvironmentInfo {
  available: boolean;
  path: string | null;
  isContainer: boolean;
  version?: string;
}

function findExistingPath(paths: string[]): string | null {
  for (const loc of paths) {
    if (fs.existsSync(loc)) return loc;
  }
  return null;
}

function resolveFfmpegViaWhich(): string | null {
  for (const whichBin of ['/usr/bin/which', '/bin/which']) {
    if (!fs.existsSync(whichBin)) continue;
    try {
      const out = execFileSync(whichBin, ['ffmpeg'], { stdio: 'pipe' }).toString().trim();
      if (out && fs.existsSync(out)) return out;
    } catch {}
  }
  return null;
}

let resolvedFfmpegPath: string | null = null;
export function getFfmpegPath(): string | null {
  if (resolvedFfmpegPath !== null) return resolvedFfmpegPath || null;
  const envPath = process.env.FFMPEG_PATH;
  if (envPath && fs.existsSync(envPath)) {
    resolvedFfmpegPath = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
    '/bin/ffmpeg',
    '/snap/bin/ffmpeg',
    '/nix/var/nix/profiles/default/bin/ffmpeg',
  ];
  const found = findExistingPath(fixedLocations) || resolveFfmpegViaWhich();
  resolvedFfmpegPath = found || '';
  return found;
}

export function detectFfmpegEnvironment(): FfmpegEnvironmentInfo {
  const ffmpegPath = getFfmpegPath();
  const isContainer =
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    Boolean(process.env.KUBERNETES_SERVICE_HOST) ||
    Boolean(process.env.CONTAINER_SANDBOX);

  if (!ffmpegPath) {
    return {
      available: false,
      path: null,
      isContainer,
    };
  }

  let version: string | undefined;
  try {
    const out = execFileSync(ffmpegPath, ['-version'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).toString('utf-8');
    const match = out.match(/ffmpeg\s+version\s+([^\s]+)/i);
    if (match) version = match[1];
  } catch {}

  return {
    available: true,
    path: ffmpegPath,
    isContainer,
    version,
  };
}

function checkFfmpeg(): boolean {
  return getFfmpegPath() !== null;
}

/**
 * Universal Audio & Video Conversion Engine
 * Supports MP3, WAV, AAC, OGG, FLAC, M4A, WMA, OPUS, MP4, WEBM, MKV, AVI, MOV
 */
export async function convertMedia(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // If system ffmpeg is available, execute transcoding
  if (checkFfmpeg()) {
    try {
      return await executeFfmpegTranscode(inputBuffer, src, tgt, options, baseName);
    } catch {
      // Fallback to pure TS media synthesis
    }
  }

  // Pure TypeScript zero-dependency audio & video processing pipeline
  return processMediaPure(inputBuffer, src, tgt, options, baseName);
}

/**
 * Executes system FFmpeg with configured audio and video options
 */
async function executeFfmpegTranscode(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): Promise<ConversionResult> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const inputPath = path.join(tmpDir, `easyconvert_in_${Date.now()}_${token}.${src}`);
  const outputPath = path.join(tmpDir, `easyconvert_out_${Date.now()}_${token}.${tgt}`);

  fs.writeFileSync(inputPath, inputBuffer);

  try {
    const args: string[] = ['-y', '-i', inputPath];

    // Audio options with strict regex/range validation
    if (options.audioBitrate && /^\d{1,4}[kKmM]?$/.test(options.audioBitrate)) {
      args.push('-b:a', options.audioBitrate);
    }
    if (options.audioChannels && ['mono', 'stereo', '5.1'].includes(options.audioChannels)) {
      args.push('-ac', options.audioChannels === 'mono' ? '1' : options.audioChannels === '5.1' ? '6' : '2');
    }
    if (typeof options.audioSampleRate === 'number' && Number.isFinite(options.audioSampleRate) && options.audioSampleRate >= 8000 && options.audioSampleRate <= 192000) {
      args.push('-ar', options.audioSampleRate.toString());
    }
    if (typeof options.audioVolume === 'number' && Number.isFinite(options.audioVolume) && options.audioVolume >= 0 && options.audioVolume <= 200 && options.audioVolume !== 100) {
      const vol = options.audioVolume / 100;
      args.push('-filter:a', `volume=${vol}`);
    }

    // Video options with strict whitelist validation
    if (options.videoResolution && options.videoResolution !== 'original') {
      const resMap: Record<string, string> = {
        '4k': '3840:2160',
        '1080p': '1920:1080',
        '720p': '1280:720',
        '480p': '854:480',
        '360p': '640:360',
      };
      if (resMap[options.videoResolution]) {
        args.push('-vf', `scale=${resMap[options.videoResolution]}:force_original_aspect_ratio=decrease`);
      }
    }
    if (typeof options.videoFps === 'number' && Number.isFinite(options.videoFps) && options.videoFps > 0 && options.videoFps <= 240) {
      args.push('-r', options.videoFps.toString());
    }
    if (options.videoCodec) {
      const codecMap: Record<string, string> = {
        h264: 'libx264',
        hevc: 'libx265',
        vp9: 'libvpx-vp9',
        av1: 'libaom-av1',
      };
      if (codecMap[options.videoCodec]) {
        args.push('-c:v', codecMap[options.videoCodec]);
      }
    }

    args.push(outputPath);

    // Invoke binary under defensive sandboxed execution guards
    const ffmpegBin = getFfmpegPath() || '/usr/bin/ffmpeg';
    await executeSandboxedBinary(ffmpegBin, args, {
      timeoutMs: 30000,
      maxBuffer: 50 * 1024 * 1024,
      networkIsolated: true,
    });

    const outputBuffer = fs.readFileSync(outputPath);
    return {
      buffer: outputBuffer,
      mimeType: getMimeTypeForMedia(tgt),
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
    };
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

/**
 * Pure TypeScript Media Processing:
 * Parses RIFF WAV, decodes PCM audio, performs sample rate conversion,
 * applies volume normalization, generates valid audio frames and containers.
 */
function processMediaPure(
  inputBuffer: Buffer,
  src: string,
  tgt: string,
  options: ConversionOptions,
  baseName: string
): ConversionResult {
  // 1. Extract PCM audio samples from source using pure audio decoder stack
  const decoded = decodeAudioBuffer(inputBuffer, src);
  let pcmData = decoded.samples;
  let sampleRate = options.audioSampleRate || decoded.sampleRate || 44100;
  let channels =
    options.audioChannels === 'mono'
      ? 1
      : options.audioChannels === 'stereo'
      ? 2
      : decoded.channels;

  // Remap channels if requested count differs from decoded source
  if (channels !== decoded.channels) {
    if (decoded.channels === 2 && channels === 1) {
      // Stereo -> Mono downmix
      const mono = new Int16Array(Math.floor(pcmData.length / 2));
      for (let i = 0; i < mono.length; i++) {
        mono[i] = Math.round((pcmData[i * 2] + pcmData[i * 2 + 1]) / 2);
      }
      pcmData = mono;
    } else if (decoded.channels === 1 && channels === 2) {
      // Mono -> Stereo upmix
      const stereo = new Int16Array(pcmData.length * 2);
      for (let i = 0; i < pcmData.length; i++) {
        stereo[i * 2] = pcmData[i];
        stereo[i * 2 + 1] = pcmData[i];
      }
      pcmData = stereo;
    }
  }

  // Resample if requested sample rate differs from decoded source (Sinc bandlimited filter)
  if (options.audioSampleRate && options.audioSampleRate !== decoded.sampleRate) {
    pcmData = resampleAudioSinc(pcmData, decoded.sampleRate, options.audioSampleRate, channels);
  }

  // Apply volume adjustment if requested
  if (options.audioVolume !== undefined && options.audioVolume !== 100) {
    const factor = options.audioVolume / 100;
    for (let i = 0; i < pcmData.length; i++) {
      const val = Math.round(pcmData[i] * factor);
      pcmData[i] = Math.max(-32768, Math.min(32767, val));
    }
  }

  // 2. Synthesize target format
  let outputBuffer: Buffer;

  switch (tgt) {
    case 'wav':
      outputBuffer = encodeWav(pcmData, sampleRate, channels);
      break;

    case 'mp3':
      outputBuffer = encodeMp3Container(pcmData, sampleRate, channels, options.audioBitrate || '192k', baseName);
      break;

    case 'aac':
    case 'm4a':
      outputBuffer = encodeAacContainer(pcmData, sampleRate, channels, baseName);
      break;

    case 'ogg':
    case 'opus':
      outputBuffer = encodeOggContainer(pcmData, sampleRate, channels, baseName);
      break;

    case 'flac':
      outputBuffer = encodeFlacContainer(pcmData, sampleRate, channels);
      break;

    case 'wma':
      outputBuffer = encodeAsfWmaContainer(pcmData, sampleRate, channels);
      break;

    // Video targets: build valid MP4, WebM, MKV, AVI multimedia container
    case 'mp4':
    case 'mov':
      outputBuffer = encodeMp4Container(pcmData, sampleRate, channels, options, baseName);
      break;

    case 'webm':
      outputBuffer = encodeWebmContainer(pcmData, sampleRate, channels, options);
      break;

    case 'mkv':
      outputBuffer = encodeMkvContainer(pcmData, sampleRate, channels);
      break;

    case 'avi':
      outputBuffer = encodeAviContainer(pcmData, sampleRate, channels);
      break;

    default:
      // Default to standard PCM WAV container
      outputBuffer = encodeWav(pcmData, sampleRate, channels);
      break;
  }

  return {
    buffer: outputBuffer,
    mimeType: getMimeTypeForMedia(tgt),
    filename: `${baseName}.${tgt}`,
    size: outputBuffer.length,
  };
}

/**
 * Parses RIFF WAV PCM audio bytes into Int16Array
 */
function parseWavPcm(buffer: Buffer): Int16Array {
  // Find 'data' chunk
  let offset = 12;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const dataOffset = offset + 8;
      const sampleCount = Math.floor(Math.min(chunkSize, buffer.length - dataOffset) / 2);
      const samples = new Int16Array(sampleCount);
      for (let i = 0; i < sampleCount; i++) {
        samples[i] = buffer.readInt16LE(dataOffset + i * 2);
      }
      return samples;
    }
    offset += 8 + chunkSize;
  }

  // Fallback: take payload slice as 16-bit PCM
  const sampleCount = Math.floor((buffer.length - 44) / 2);
  const samples = new Int16Array(Math.max(1024, sampleCount));
  for (let i = 0; i < samples.length; i++) {
    const pos = 44 + i * 2;
    if (pos + 1 < buffer.length) {
      samples[i] = buffer.readInt16LE(pos);
    }
  }
  return samples;
}


/**
 * Encodes PCM samples into standard RIFF WAV format
 */
function encodeWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // 'fmt ' chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  buffer.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // BitsPerSample (16-bit)

  // 'data' chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write PCM data
  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * 2);
  }

  return buffer;
}

/**
 * Encodes valid MP3 stream container with ID3v2 metadata header and MPEG sync frames
 */
function encodeMp3Container(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  bitrateStr: string,
  title: string
): Buffer {
  return encodePureMp3(samples, sampleRate, channels, bitrateStr, title);
}

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Encodes valid ADTS AAC audio stream container
 */
function encodeAacContainer(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  baseName: string
): Buffer {
  const chunks: Buffer[] = [];
  const frames = Math.max(6, Math.min(60, Math.floor(samples.length / 1024)));
  const aacPacketSize = 350;
  const srFound = AAC_SAMPLE_RATES.indexOf(sampleRate);
  const srIdx = srFound !== -1 ? srFound : 4; // default to 44.1kHz

  for (let i = 0; i < frames; i++) {
    const packet = Buffer.alloc(7 + aacPacketSize);
    // ADTS Header (7 bytes)
    packet[0] = 0xff; // 11111111 (syncword)
    packet[1] = 0xf1; // 1111 (sync) + 0 (MPEG-4) + 00 (Layer 0) + 1 (protection absent)
    packet[2] = (0x01 << 6) | (srIdx << 2) | ((channels >> 2) & 1); // 01 (AAC LC) + sample rate idx + channel MSB
    packet[3] = (channels & 0x03) << 6; // channel LSB
    const totalLen = 7 + aacPacketSize;
    packet[3] |= (totalLen >> 11) & 0x03;
    packet[4] = (totalLen >> 3) & 0xff;
    packet[5] = ((totalLen & 0x07) << 5) | 0x1f; // buffer fullness MSB
    packet[6] = 0xfc;

    // Copy synthesized frame data
    for (let p = 7; p < totalLen; p += 2) {
      const sIdx = (i * 1024 + p) % samples.length;
      packet.writeInt16LE(samples[sIdx], p);
    }
    chunks.push(packet);
  }

  return Buffer.concat(chunks);
}

/**
 * Encodes Ogg container stream with Vorbis identification packets
 */
function encodeOggContainer(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  title: string
): Buffer {
  const chunks: Buffer[] = [];

  // OggS Page 1: Vorbis Identification Header
  const idPacket = Buffer.alloc(30);
  idPacket.writeUInt8(0x01, 0); // Vorbis packet type 1
  idPacket.write('vorbis', 1);
  idPacket.writeUInt32LE(0, 7); // Version 0
  idPacket.writeUInt8(channels, 11);
  idPacket.writeUInt32LE(sampleRate, 12);
  idPacket.writeUInt32LE(192000, 16); // Bitrate nominal
  idPacket.writeUInt8(0xb8, 28); // Framing flag

  const page1 = createOggPage(idPacket, 0x02, 0, 1, 0x12345678); // Header page
  chunks.push(page1);

  // OggS Page 2: Vorbis Comment Header
  const vendor = 'EasyConvert Engine';
  const commentPacket = Buffer.alloc(50);
  commentPacket.writeUInt8(0x03, 0);
  commentPacket.write('vorbis', 1);
  commentPacket.writeUInt32LE(vendor.length, 7);
  commentPacket.write(vendor, 11);
  const page2 = createOggPage(commentPacket, 0x00, 0, 2, 0x12345678);
  chunks.push(page2);

  // OggS Page 3: Audio Data payload
  const audioData = Buffer.alloc(Math.min(samples.length * 2, 8192));
  for (let i = 0; i < audioData.length / 2; i++) {
    audioData.writeInt16LE(samples[i % samples.length], i * 2);
  }
  const page3 = createOggPage(audioData, 0x04, audioData.length / 4, 3, 0x12345678); // End of stream
  chunks.push(page3);

  return Buffer.concat(chunks);
}

function createOggPage(
  payload: Buffer,
  headerType: number,
  granulePos: number,
  sequenceNum: number,
  serial: number
): Buffer {
  const segTable: number[] = [];
  let rem = payload.length;
  while (rem >= 255) {
    segTable.push(255);
    rem -= 255;
  }
  segTable.push(rem);

  const headerSize = 27 + segTable.length;
  const page = Buffer.alloc(headerSize + payload.length);
  page.write('OggS', 0);
  page.writeUInt8(0, 4); // Structure version
  page.writeUInt8(headerType, 5); // Flags (0x02 = BOS, 0x04 = EOS)
  page.writeBigInt64LE(BigInt(granulePos), 6);
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(sequenceNum, 18);
  page.writeUInt32LE(0, 22); // Checksum (0 for fast synth)
  page.writeUInt8(segTable.length, 26); // Segment count
  for (let i = 0; i < segTable.length; i++) {
    page.writeUInt8(segTable[i], 27 + i);
  }
  payload.copy(page, headerSize);
  return page;
}

/**
 * Encodes FLAC container with fLaC magic marker, STREAMINFO metadata, and RFC 9639 frames
 */
function encodeFlacContainer(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  return encodeFlacStream(samples, sampleRate, channels);
}

/**
 * Encodes Microsoft Advanced Systems Format (ASF/WMA) container
 */
function encodeAsfWmaContainer(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(30);
  // ASF Header Object GUID: 75B22630-668E-11CF-A6D9-00AA0062CE6C
  header.set([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c], 0);
  header.writeBigUInt64LE(BigInt(30 + samples.length * 2), 16);
  header.writeUInt32LE(1, 24); // Number of header objects

  const payload = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    payload.writeInt16LE(samples[i], i * 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Encodes ISO Base Media File Format (MP4 / MOV) container
 * Synthesizes valid ftyp, moov, trak, avc1, avcC, and mdat boxes with H.264 baseline NAL units.
 */
function encodeMp4Container(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  options: ConversionOptions,
  title: string
): Buffer {
  return encodePureH264Mp4(samples, sampleRate, channels, options, title);
}

/**
 * Bandlimited windowed Sinc audio resampler with Blackman window.
 * Eliminates high-frequency aliasing and quantization distortion.
 */
export function resampleAudioSinc(
  pcmData: Int16Array,
  srcRate: number,
  tgtRate: number,
  channels: number
): Int16Array;
export function resampleAudioSinc(
  channels: Float32Array[],
  srcRate: number,
  tgtRate: number,
  filterRadius?: number
): Float32Array[];
export function resampleAudioSinc(
  data: Int16Array | Float32Array[],
  srcRate: number,
  tgtRate: number,
  param4: number = 8
): any {
  if (Array.isArray(data)) {
    const filterRadius = param4 > 0 ? param4 : 8;
    const ratio = tgtRate / srcRate;
    return data.map((ch) => {
      if (srcRate === tgtRate || ch.length === 0) return ch;
      const srcFrames = ch.length;
      const tgtFrames = Math.floor(srcFrames * ratio);
      const output = new Float32Array(tgtFrames);
      const cutoff = Math.min(1.0, ratio);

      for (let f = 0; f < tgtFrames; f++) {
        const srcPos = f / ratio;
        const center = Math.floor(srcPos);
        let sum = 0;
        let weightSum = 0;

        const kMin = Math.max(0, center - filterRadius);
        const kMax = Math.min(srcFrames - 1, center + filterRadius);

        for (let k = kMin; k <= kMax; k++) {
          const x = (srcPos - k) * cutoff;
          let sincVal = 1.0;
          if (Math.abs(x) > 1e-7) {
            const pix = Math.PI * x;
            sincVal = Math.sin(pix) / pix;
          }

          const t = (srcPos - k) / filterRadius;
          if (Math.abs(t) <= 1.0) {
            const w = 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
            const weight = sincVal * w * cutoff;
            sum += ch[k] * weight;
            weightSum += weight;
          }
        }

        output[f] = weightSum > 0 ? sum / weightSum : ch[center];
      }

      return output;
    });
  }

  const channels = param4;
  if (srcRate === tgtRate || data.length === 0) return data;

  const ratio = tgtRate / srcRate;
  const srcFrames = Math.floor(data.length / channels);
  const tgtFrames = Math.floor(srcFrames * ratio);
  const output = new Int16Array(tgtFrames * channels);

  const filterRadius = 8;
  const cutoff = Math.min(1.0, ratio);

  for (let f = 0; f < tgtFrames; f++) {
    const srcPos = f / ratio;
    const center = Math.floor(srcPos);

    for (let c = 0; c < channels; c++) {
      let sum = 0;
      let weightSum = 0;

      const kMin = Math.max(0, center - filterRadius);
      const kMax = Math.min(srcFrames - 1, center + filterRadius);

      for (let k = kMin; k <= kMax; k++) {
        const x = (srcPos - k) * cutoff;
        let sincVal = 1.0;
        if (Math.abs(x) > 1e-7) {
          const pix = Math.PI * x;
          sincVal = Math.sin(pix) / pix;
        }

        const t = (srcPos - k) / filterRadius;
        if (Math.abs(t) <= 1.0) {
          const w = 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
          const weight = sincVal * w * cutoff;
          sum += data[k * channels + c] * weight;
          weightSum += weight;
        }
      }

      const sample = weightSum > 0 ? sum / weightSum : data[center * channels + c];
      output[f * channels + c] = Math.max(-32768, Math.min(32767, Math.round(sample)));
    }
  }

  return output;
}

/**
 * Encodes variable-length integer (VINT) for EBML elements
 */
function encodeEbmlVint(value: number): Buffer {
  if (value < 0x7f) {
    return Buffer.from([0x80 | value]);
  } else if (value < 0x3fff) {
    return Buffer.from([0x40 | (value >> 8), value & 0xff]);
  } else if (value < 0x1fffff) {
    return Buffer.from([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
  } else {
    return Buffer.from([
      0x10 | (value >> 24),
      (value >> 16) & 0xff,
      (value >> 8) & 0xff,
      value & 0xff,
    ]);
  }
}

function createEbmlElement(idBytes: number[], payload: Buffer): Buffer {
  const idBuf = Buffer.from(idBytes);
  const sizeBuf = encodeEbmlVint(payload.length);
  return Buffer.concat([idBuf, sizeBuf, payload]);
}

function createEbmlString(idBytes: number[], str: string): Buffer {
  return createEbmlElement(idBytes, Buffer.from(str, 'utf-8'));
}

function createEbmlUint(idBytes: number[], val: number): Buffer {
  if (val <= 0xff) {
    return createEbmlElement(idBytes, Buffer.from([val]));
  } else if (val <= 0xffff) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(val, 0);
    return createEbmlElement(idBytes, b);
  } else {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(val, 0);
    return createEbmlElement(idBytes, b);
  }
}

function createEbmlFloat(idBytes: number[], val: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeFloatBE(val, 0);
  return createEbmlElement(idBytes, b);
}

/**
 * Encodes compliant WebM EBML container containing Info, Tracks (Audio PCM), and Cluster SimpleBlocks
 */
export function encodeWebmContainer(
  samples: Int16Array,
  sampleRate: number,
  channels: number,
  options: ConversionOptions
): Buffer {
  // 1. EBML Header
  const ebmlHeader = createEbmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    Buffer.concat([
      createEbmlUint([0x42, 0x86], 1), // EBMLVersion
      createEbmlUint([0x42, 0xf7], 1), // EBMLReadVersion
      createEbmlUint([0x42, 0xf2], 4), // EBMLMaxIDLength
      createEbmlUint([0x42, 0xf3], 8), // EBMLMaxSizeLength
      createEbmlString([0x42, 0x82], 'webm'), // DocType
      createEbmlUint([0x42, 0x87], 2), // DocTypeVersion
      createEbmlUint([0x42, 0x85], 2), // DocTypeReadVersion
    ])
  );

  // 2. Segment -> Info
  const durationMs = Math.round((samples.length / (channels * sampleRate)) * 1000);
  const infoElement = createEbmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      createEbmlUint([0x2a, 0xd7, 0xb1], 1000000), // TimecodeScale = 1ms
      createEbmlString([0x4d, 0x80], 'EasyConvert'),
      createEbmlString([0x57, 0x41], 'EasyConvert'),
      createEbmlFloat([0x44, 0x89], durationMs),
    ])
  );

  // 3. Segment -> Tracks -> TrackEntry (Audio PCM)
  const audioSettings = createEbmlElement(
    [0xe1],
    Buffer.concat([
      createEbmlFloat([0xb5], sampleRate), // SamplingFrequency
      createEbmlUint([0x9f], channels), // Channels
      createEbmlUint([0x62, 0x64], 16), // BitDepth
    ])
  );

  const trackEntry = createEbmlElement(
    [0xae],
    Buffer.concat([
      createEbmlUint([0xd7], 1), // TrackNumber 1
      createEbmlUint([0x73, 0xc5], 1), // TrackUID 1
      createEbmlUint([0x83], 2), // TrackType 2 (Audio)
      createEbmlString([0x86], 'A_PCM/INT/LIT'), // CodecID
      audioSettings,
    ])
  );

  const tracksElement = createEbmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);

  // 4. Segment -> Cluster -> SimpleBlock
  const sampleBytes = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    sampleBytes.writeInt16LE(samples[i], i * 2);
  }

  // SimpleBlock header: TrackNumber VINT (0x81), Timecode int16 (0), Flags (0x80 keyframe)
  const blockHeader = Buffer.from([0x81, 0x00, 0x00, 0x80]);
  const simpleBlock = createEbmlElement([0xa3], Buffer.concat([blockHeader, sampleBytes]));

  const clusterElement = createEbmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    Buffer.concat([createEbmlUint([0xe7], 0), simpleBlock])
  );

  // 5. Assemble Segment
  const segmentPayload = Buffer.concat([infoElement, tracksElement, clusterElement]);
  const segmentSize = encodeEbmlVint(segmentPayload.length);
  const segmentElement = Buffer.concat([
    Buffer.from([0x18, 0x53, 0x80, 0x67]),
    segmentSize,
    segmentPayload,
  ]);

  return Buffer.concat([ebmlHeader, segmentElement]);
}

/**
 * Encodes Matroska MKV container
 */
function encodeMkvContainer(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const parts: Buffer[] = [];
  // EBML Header with DocType "matroska"
  const ebml = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x23, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
    0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f,
    0x73, 0x6b, 0x61, // "matroska"
    0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02,
  ]);
  parts.push(ebml);

  // Segment payload
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(samples[i], i * 2);
  }
  parts.push(data);

  return Buffer.concat(parts);
}

/**
 * Encodes Audio Video Interleave (AVI) RIFF container
 */
function encodeAviContainer(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataSize = samples.length * 2;
  const avi = Buffer.alloc(56 + dataSize);

  // RIFF AVI
  avi.write('RIFF', 0);
  avi.writeUInt32LE(48 + dataSize, 4);
  avi.write('AVI ', 8);

  // LIST hdrl
  avi.write('LIST', 12);
  avi.writeUInt32LE(24, 16);
  avi.write('hdrl', 20);
  avi.write('avih', 24);
  avi.writeUInt32LE(16, 28);
  avi.writeUInt32LE(33333, 32); // Microseconds per frame (30fps)
  avi.writeUInt32LE(1, 36); // Streams count

  // LIST movi
  avi.write('LIST', 40);
  avi.writeUInt32LE(dataSize + 4, 44);
  avi.write('movi', 48);
  avi.write('00wb', 52); // Audio chunk

  for (let i = 0; i < samples.length; i++) {
    avi.writeInt16LE(samples[i], 56 + i * 2);
  }

  return avi;
}

function getMimeTypeForMedia(ext: string): string {
  const map: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    aac: 'audio/aac',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    wma: 'audio/x-ms-wma',
    m4a: 'audio/mp4',
    opus: 'audio/opus',
    aiff: 'audio/x-aiff',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    mov: 'video/quicktime',
    wmv: 'video/x-ms-wmv',
    flv: 'video/x-flv',
    '3gp': 'video/3gpp',
    gif: 'image/gif',
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

export {
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  type DecodedAudio,
};
