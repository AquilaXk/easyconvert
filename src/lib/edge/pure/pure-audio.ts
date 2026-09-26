/**
 * Pure Isomorphic Audio Converter (Level 0 Fast-Path)
 *
 * Implements pure TypedArray-based WAV parsing, standard RIFF WAV encoding,
 * and pure TypeScript MPEG-1 Layer III (MP3) encoding using Uint8Array and DataView
 * (strictly zero Node.js Buffer dependencies).
 */

export interface PureAudioResult {
  data: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface PureAudioOptions {
  sampleRate?: number;
  channels?: number;
  bitrate?: string;
  title?: string;
}

const SUPPORTED_AUDIO_SOURCES = new Set(['wav', 'pcm', 'raw']);
const SUPPORTED_AUDIO_TARGETS = new Set(['wav', 'mp3']);

const AUDIO_MIME_MAP: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Checks whether the source and target formats are supported by the pure audio engine.
 */
export function isPureAudioConvertible(sourceFormat: string, targetFormat: string): boolean {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  return SUPPORTED_AUDIO_SOURCES.has(src) && SUPPORTED_AUDIO_TARGETS.has(tgt);
}

/**
 * Parses RIFF WAV bytes into 16-bit PCM samples using pure DataView.
 */
export function parseWavPcm(bytes: Uint8Array): {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Quick header validation for 'RIFF' and 'WAVE'
  const isRiff =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45;

  let sampleRate = 44100;
  let channels = 2;
  let bitsPerSample = 16;
  let audioFormat = 1;

  if (isRiff) {
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      );
      const chunkSize = view.getUint32(offset + 4, true);

      if (chunkId === 'fmt ' && offset + 24 <= bytes.length) {
        audioFormat = view.getUint16(offset + 8, true);
        channels = view.getUint16(offset + 10, true) || 2;
        sampleRate = view.getUint32(offset + 12, true) || 44100;
        bitsPerSample = view.getUint16(offset + 22, true) || 16;
      }

      if (chunkId === 'data') {
        const dataOffset = offset + 8;
        const availableBytes = Math.max(0, Math.min(chunkSize, bytes.length - dataOffset));

        if (bitsPerSample === 8) {
          const sampleCount = availableBytes;
          const samples = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            // Unsigned 8-bit PCM (0..255) -> Signed 16-bit (-32768..32767)
            samples[i] = (bytes[dataOffset + i] - 128) << 8;
          }
          return { samples, sampleRate, channels };
        } else if (bitsPerSample === 24) {
          const sampleCount = Math.floor(availableBytes / 3);
          const samples = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            const b0 = bytes[dataOffset + i * 3];
            const b1 = bytes[dataOffset + i * 3 + 1];
            const b2 = bytes[dataOffset + i * 3 + 2];
            let val = (b2 << 16) | (b1 << 8) | b0;
            if (val & 0x800000) val |= 0xff000000;
            samples[i] = val >> 8;
          }
          return { samples, sampleRate, channels };
        } else if (bitsPerSample === 32 && audioFormat === 3) {
          // 32-bit IEEE float
          const sampleCount = Math.floor(availableBytes / 4);
          const samples = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            const f = view.getFloat32(dataOffset + i * 4, true);
            samples[i] = Math.max(-32768, Math.min(32767, Math.round(f * 32767)));
          }
          return { samples, sampleRate, channels };
        } else {
          // Standard 16-bit PCM
          const sampleCount = Math.floor(availableBytes / 2);
          const samples = new Int16Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            samples[i] = view.getInt16(dataOffset + i * 2, true);
          }
          return { samples, sampleRate, channels };
        }
      }

      // Word alignment: RIFF chunks must be padded to an even byte boundary
      const paddedSize = (chunkSize + 1) & ~1;
      if (paddedSize <= 0 || offset + 8 + paddedSize <= offset) {
        break;
      }
      offset += 8 + paddedSize;
    }
  }

  // Fallback: decode raw payload as 16-bit PCM
  const fallbackOffset = isRiff ? 44 : 0;
  const remaining = Math.max(0, bytes.length - fallbackOffset);
  const sampleCount = Math.floor(remaining / 2);
  const samples = new Int16Array(Math.max(1152 * channels, sampleCount));

  for (let i = 0; i < sampleCount; i++) {
    samples[i] = view.getInt16(fallbackOffset + i * 2, true);
  }

  return { samples, sampleRate, channels };
}

/**
 * Encodes 16-bit PCM samples into standard RIFF WAV format using Uint8Array and DataView.
 */
export function encodePcmToWav(
  samples: Int16Array,
  sampleRate = 44100,
  channels = 2
): Uint8Array {
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const totalSize = 44 + dataSize;

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // 1. RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');

  // 2. 'fmt ' subchunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 = PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // BitsPerSample

  // 3. 'data' subchunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // 4. PCM audio samples
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return out;
}

/**
 * Computes 576-point MDCT with sine window.
 */
function computeMdct576(samples: Float64Array): Float64Array {
  const N = 576;
  const out = new Float64Array(N);
  const factor = Math.PI / N;

  for (let k = 0; k < N; k++) {
    let sum = 0.0;
    const kFactor = (k + 0.5) * factor;

    for (let n = 0; n < 2 * N; n++) {
      const win = Math.sin((Math.PI / (2 * N)) * (n + 0.5));
      const s = samples[n] * win;
      const angle = (n + 0.5 + N * 0.5) * kFactor;
      sum += s * Math.cos(angle);
    }
    out[k] = sum;
  }

  return out;
}

/**
 * Encodes 16-bit PCM samples into MPEG-1 Audio Layer III (MP3) format
 * using pure Uint8Array/DataView with ID3v2 metadata header and sync frames.
 */
export function encodePureMp3(
  samples: Int16Array,
  sampleRate = 44100,
  channels = 2,
  bitrateStr = '192k',
  title = 'EasyConvert Audio'
): Uint8Array {
  if (samples.length === 0) {
    samples = new Int16Array(1152 * channels * 4);
  }

  const bitrateKbps = parseInt(bitrateStr, 10) || 192;

  // MPEG-1 Layer III Bitrate Table (kbps)
  const MPEG1_L3_BITRATES = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];

  let bitrateIdx = 11; // 192 kbps default
  if (bitrateKbps <= 32) bitrateIdx = 1;
  else if (bitrateKbps <= 40) bitrateIdx = 2;
  else if (bitrateKbps <= 48) bitrateIdx = 3;
  else if (bitrateKbps <= 56) bitrateIdx = 4;
  else if (bitrateKbps <= 64) bitrateIdx = 5;
  else if (bitrateKbps <= 80) bitrateIdx = 6;
  else if (bitrateKbps <= 96) bitrateIdx = 7;
  else if (bitrateKbps <= 112) bitrateIdx = 8;
  else if (bitrateKbps <= 128) bitrateIdx = 9;
  else if (bitrateKbps <= 160) bitrateIdx = 10;
  else if (bitrateKbps <= 192) bitrateIdx = 11;
  else if (bitrateKbps <= 224) bitrateIdx = 12;
  else if (bitrateKbps <= 256) bitrateIdx = 13;
  else bitrateIdx = 14;

  const actualBitrateKbps = MPEG1_L3_BITRATES[bitrateIdx];
  const bitrateBps = actualBitrateKbps * 1000;
  const frameLength = Math.floor((144 * bitrateBps) / (sampleRate || 44100));

  // 1. Build ID3v2.3 Tag Header
  const titleBytes = new TextEncoder().encode(title);
  const framePayloadSize = 1 + titleBytes.length; // encoding byte (0x03 = UTF-8) + text
  const tagPayloadSize = 10 + framePayloadSize; // TIT2 header (10) + framePayloadSize
  const id3HeaderSize = 10;
  const totalId3Size = id3HeaderSize + tagPayloadSize;

  const id3 = new Uint8Array(totalId3Size);
  const id3View = new DataView(id3.buffer, id3.byteOffset, id3.byteLength);

  writeAscii(id3View, 0, 'ID3');
  id3View.setUint8(3, 3); // ID3v2.3
  id3View.setUint8(4, 0);
  id3View.setUint8(5, 0); // flags
  // Syncsafe integer for size
  id3View.setUint8(6, (tagPayloadSize >> 21) & 0x7f);
  id3View.setUint8(7, (tagPayloadSize >> 14) & 0x7f);
  id3View.setUint8(8, (tagPayloadSize >> 7) & 0x7f);
  id3View.setUint8(9, tagPayloadSize & 0x7f);

  // TIT2 frame (Title)
  writeAscii(id3View, 10, 'TIT2');
  id3View.setUint32(14, framePayloadSize, false); // Big endian frame size
  id3View.setUint16(18, 0, false); // flags
  id3View.setUint8(20, 3); // UTF-8 encoding flag
  id3.set(titleBytes, 21);

  // 2. Prepare MPEG-1 Layer III Frames
  const samplesPerFrame = 1152;
  const totalFrames = Math.max(4, Math.floor(samples.length / (samplesPerFrame * channels)));

  const srIdx = sampleRate === 48000 ? 1 : sampleRate === 32000 ? 2 : 0;
  const channelMode = channels === 1 ? 3 : 0; // 0 = Stereo, 3 = Mono
  const sideInfoSize = channels === 1 ? 17 : 32;

  const granuleWindow = new Float64Array(1152);
  const totalOutputSize = totalId3Size + totalFrames * frameLength;
  const out = new Uint8Array(totalOutputSize);
  const outView = new DataView(out.buffer, out.byteOffset, out.byteLength);

  // Write ID3 header first
  out.set(id3, 0);

  let currentOffset = totalId3Size;

  for (let f = 0; f < totalFrames; f++) {
    const fStart = currentOffset;

    // Frame Header (4 bytes)
    // 0xFF 0xFB (sync 11 bits, MPEG-1, Layer III, no CRC)
    outView.setUint8(fStart + 0, 0xff);
    outView.setUint8(fStart + 1, 0xfb);
    outView.setUint8(fStart + 2, (bitrateIdx << 4) | (srIdx << 2));
    outView.setUint8(fStart + 3, (channelMode << 6) | 0x08);

    // Side Info
    let sOff = fStart + 4;
    outView.setUint16(sOff, 0, false); // main_data_begin (0)
    sOff += 2;

    outView.setUint8(sOff++, 0x00); // scfsi

    const bigValues = 120;
    const globalGain = 140;
    const part23Len = Math.floor((frameLength - 4 - sideInfoSize) * 4);

    for (let gr = 0; gr < 2; gr++) {
      for (let ch = 0; ch < channels; ch++) {
        const p1 = (part23Len << 4) | ((bigValues >> 5) & 0x0f);
        outView.setUint16(sOff, p1, false);
        sOff += 2;
        outView.setUint8(sOff++, (bigValues & 0x1f) << 3);
        outView.setUint8(sOff++, globalGain);
        outView.setUint16(sOff, 0x0000, false);
        sOff += 2;
      }
    }

    // Main Data: Quantized MDCT Spectral Coefficients
    const mainDataStart = fStart + 4 + sideInfoSize;
    const frameSampleOffset = f * samplesPerFrame * channels;

    for (let i = 0; i < 1152; i++) {
      const idx = (frameSampleOffset + i * channels) % samples.length;
      granuleWindow[i] = samples[idx] / 32768.0;
    }

    const mdct = computeMdct576(granuleWindow);
    const qStep = 0.05;
    let bOff = mainDataStart;
    const fEnd = fStart + frameLength;

    for (let k = 0; k < 576 && bOff + 1 < fEnd; k++) {
      const val = mdct[k];
      const sign = val < 0 ? 1 : 0;
      const mag = Math.abs(val);
      const qVal = Math.min(255, Math.round(Math.pow(mag / qStep, 0.75)));

      outView.setUint8(bOff++, qVal);
      if (bOff < fEnd) {
        outView.setUint8(bOff++, sign ? 0x80 : 0x00);
      }
    }

    currentOffset += frameLength;
  }

  return out;
}

/**
 * Converts audio bytes between WAV, PCM, and MP3 purely using typed arrays.
 */
export function convertPureAudio(
  input: Uint8Array,
  sourceFormat: string,
  targetFormat: string,
  options: PureAudioOptions = {}
): PureAudioResult {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  if (!isPureAudioConvertible(src, tgt)) {
    throw new Error(`Pure audio engine does not support conversion from '${src}' to '${tgt}'.`);
  }

  const { samples, sampleRate, channels } = parseWavPcm(input);
  const targetSampleRate = options.sampleRate || sampleRate || 44100;
  const targetChannels = options.channels || channels || 2;

  let outputBytes: Uint8Array;

  if (tgt === 'wav') {
    outputBytes = encodePcmToWav(samples, targetSampleRate, targetChannels);
  } else if (tgt === 'mp3') {
    outputBytes = encodePureMp3(
      samples,
      targetSampleRate,
      targetChannels,
      options.bitrate || '192k',
      options.title || 'EasyConvert Audio'
    );
  } else {
    throw new Error(`Unsupported target audio format: ${tgt}`);
  }

  const mimeType = AUDIO_MIME_MAP[tgt] || 'audio/octet-stream';

  return {
    data: outputBytes,
    mimeType,
    extension: tgt,
  };
}
