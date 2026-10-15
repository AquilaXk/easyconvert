/**
 * Turns the PCM that the WAV demuxer reads into the typed arrays WebCodecs `AudioData` takes.
 *
 * WebCodecs has no 24-bit sample format, so 24-bit PCM becomes `s32` with each sample shifted left by eight
 * bits, which is lossless and keeps the full scale. Samples are read as little-endian whatever the host is.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';

export type PcmAudioDataFormat = 's16' | 's32' | 'f32';

export interface PcmAudioBlock {
  format: PcmAudioDataFormat;
  data: Int16Array | Int32Array | Float32Array;
  /** Frames (one sample per channel) in the block. */
  frames: number;
}

const BYTES_S16 = 2;
const BYTES_S24 = 3;
const BYTES_S32 = 4;
const BYTES_F32 = 4;

function readS24(view: DataView, offset: number): number {
  // Sign comes from the top byte; the low 24 bits sit above bit 8 of the result.
  return (view.getUint8(offset) << 8) | (view.getUint8(offset + 1) << 16) | (view.getInt8(offset + 2) << 24);
}

/** Converts one block of interleaved PCM labelled by the demuxer codec (`pcm-s16`, `pcm-s24`, `pcm-s32`, `pcm-f32`). */
export function pcmBlockToAudioData(codec: string, bytes: Uint8Array, channels: number): PcmAudioBlock {
  let bytesPerSample: number;
  switch (codec) {
    case 'pcm-s16':
      bytesPerSample = BYTES_S16;
      break;
    case 'pcm-s24':
      bytesPerSample = BYTES_S24;
      break;
    case 'pcm-s32':
      bytesPerSample = BYTES_S32;
      break;
    case 'pcm-f32':
      bytesPerSample = BYTES_F32;
      break;
    default:
      throw new EdgeUnsupportedError(`The edge worker cannot read "${codec}" as PCM audio.`);
  }
  const frameBytes = bytesPerSample * channels;
  if (channels < 1 || bytes.byteLength === 0 || bytes.byteLength % frameBytes !== 0) {
    throw new EdgeUnsupportedError('The PCM audio holds a block that is not a whole number of frames.');
  }
  const frames = bytes.byteLength / frameBytes;
  const count = frames * channels;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (codec === 'pcm-s16') {
    const data = new Int16Array(count);
    for (let i = 0; i < count; i++) data[i] = view.getInt16(i * BYTES_S16, true);
    return { format: 's16', data, frames };
  }
  if (codec === 'pcm-f32') {
    const data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = view.getFloat32(i * BYTES_F32, true);
    return { format: 'f32', data, frames };
  }
  const data = new Int32Array(count);
  if (codec === 'pcm-s24') {
    for (let i = 0; i < count; i++) data[i] = readS24(view, i * BYTES_S24);
  } else {
    for (let i = 0; i < count; i++) data[i] = view.getInt32(i * BYTES_S32, true);
  }
  return { format: 's32', data, frames };
}
