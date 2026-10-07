/**
 * AAC-LC helpers shared by the demuxer and the muxers: the AudioSpecificConfig (ISO/IEC 14496-3 1.6.2.1), the
 * ADTS header (ISO/IEC 14496-3 1.A.2.2) and the esds descriptors that carry the configuration in MP4
 * (ISO/IEC 14496-14 5.6). Only AAC-LC is handled; any other audio object type throws EdgeUnsupportedError.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { EncodedMediaChunk, EncoderOutputConfig } from './media-types';

/** ISO/IEC 14496-3 Table 1.18, samplingFrequencyIndex 0..12. */
export const AAC_SAMPLE_RATES: readonly number[] = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];
export const AAC_LC_OBJECT_TYPE = 2;
/** The WebCodecs codec string of AAC-LC. */
export const AAC_LC_CODEC = 'mp4a.40.2';
/** MPEG-4 audio object type indication in an esds DecoderConfigDescriptor. */
export const OTI_MPEG4_AUDIO = 0x40;

const AAC_EXPLICIT_RATE_INDEX = 15;
const AAC_ESCAPE_OBJECT_TYPE = 31;
const AAC_ESCAPE_OBJECT_TYPE_BASE = 32;
const AAC_MAX_CHANNEL_CONFIG = 7;
/** channelConfiguration 1..7 are 1, 2, 3, 4, 5, 6 and 8 (7.1) channels. */
const AAC_CHANNELS_BY_CONFIG: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 8];
const BITS_PER_BYTE = 8;
const ADTS_HEADER_BYTES = 7;
/** frame_length is a 13-bit field. */
const ADTS_MAX_FRAME_BYTES = 0x1fff;
const ADTS_SYNC_AND_MPEG4_NO_CRC = [0xff, 0xf1];
const ADTS_BUFFER_FULLNESS_VBR_HIGH = 0x1f;
const ADTS_BUFFER_FULLNESS_VBR_LOW = 0xfc;

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`AAC: ${message}; the server engine converts this file.`);
}

class BitReader {
  private bit = 0;

  constructor(private readonly bytes: Uint8Array) {}

  read(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.bytes[Math.floor(this.bit / BITS_PER_BYTE)];
      if (byte === undefined) throw refuse('the AudioSpecificConfig is truncated');
      value = (value << 1) | ((byte >>> (BITS_PER_BYTE - 1 - (this.bit % BITS_PER_BYTE))) & 1);
      this.bit++;
    }
    return value;
  }
}

export interface AacLcConfig {
  sampleRate: number;
  /** samplingFrequencyIndex, or 15 when the rate is written out in the configuration. */
  samplingFrequencyIndex: number;
  channels: number;
  channelConfiguration: number;
}

/** Reads the leading AudioSpecificConfig fields of an AAC-LC stream; other object types throw. */
export function parseAacLcConfig(asc: Uint8Array): AacLcConfig {
  const bits = new BitReader(asc);
  let objectType = bits.read(5);
  if (objectType === AAC_ESCAPE_OBJECT_TYPE) objectType = AAC_ESCAPE_OBJECT_TYPE_BASE + bits.read(6);
  if (objectType !== AAC_LC_OBJECT_TYPE) {
    throw refuse(`audio object type ${objectType} is not AAC-LC, the only profile read at the edge`);
  }
  const samplingFrequencyIndex = bits.read(4);
  let sampleRate: number;
  if (samplingFrequencyIndex === AAC_EXPLICIT_RATE_INDEX) {
    sampleRate = bits.read(24);
  } else if (samplingFrequencyIndex < AAC_SAMPLE_RATES.length) {
    sampleRate = AAC_SAMPLE_RATES[samplingFrequencyIndex];
  } else {
    throw refuse(`sampling frequency index ${samplingFrequencyIndex} is reserved`);
  }
  const channelConfiguration = bits.read(4);
  if (channelConfiguration === 0 || channelConfiguration > AAC_MAX_CHANNEL_CONFIG) {
    throw refuse(`channel configuration ${channelConfiguration} needs a program config element`);
  }
  return { sampleRate, samplingFrequencyIndex, channels: AAC_CHANNELS_BY_CONFIG[channelConfiguration], channelConfiguration };
}

/**
 * The 7-byte ADTS header (MPEG-4, no CRC, AAC-LC) for one raw frame of `frameBytes` bytes, with the sampling
 * frequency and channel configuration of the stream's AudioSpecificConfig. A rate without a table index, or a
 * frame too long for the 13-bit length field, throws.
 */
export function buildAdtsHeader(frameBytes: number, config: AacLcConfig): Uint8Array {
  if (config.samplingFrequencyIndex >= AAC_SAMPLE_RATES.length) {
    throw refuse(`${config.sampleRate} Hz has no ADTS sampling frequency index`);
  }
  const length = frameBytes + ADTS_HEADER_BYTES;
  if (length > ADTS_MAX_FRAME_BYTES) throw refuse(`a ${frameBytes}-byte frame does not fit an ADTS header`);
  const profile = AAC_LC_OBJECT_TYPE - 1; // ADTS stores audioObjectType - 1
  return Uint8Array.from([
    ...ADTS_SYNC_AND_MPEG4_NO_CRC,
    (profile << 6) | (config.samplingFrequencyIndex << 2) | (config.channelConfiguration >> 2),
    ((config.channelConfiguration & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | ADTS_BUFFER_FULLNESS_VBR_HIGH,
    ADTS_BUFFER_FULLNESS_VBR_LOW,
  ]);
}

/**
 * An ADTS stream (the `.aac` file format): every raw AAC frame behind a header built from the stream's own
 * AudioSpecificConfig. The rate and channel count the audio was encoded with must agree with it.
 */
export function muxAdtsStream(
  chunks: EncodedMediaChunk[],
  config: EncoderOutputConfig,
  sampleRate: number,
  channels: number
): Uint8Array {
  if (chunks.length === 0) throw refuse('there are no frames to write');
  if (config.codec !== AAC_LC_CODEC) throw refuse(`${config.codec} is not AAC-LC`);
  if (!config.description || config.description.byteLength === 0) {
    throw refuse('the encoder reported no AudioSpecificConfig');
  }
  const asc = parseAacLcConfig(config.description);
  if (asc.sampleRate !== sampleRate || asc.channels !== channels) {
    throw refuse(
      `the AudioSpecificConfig states ${asc.sampleRate} Hz and ${asc.channels} channels, not the ${sampleRate} Hz and ${channels} channels encoded`
    );
  }
  const headers = chunks.map((chunk) => buildAdtsHeader(chunk.data.byteLength, asc));
  const total = chunks.reduce((sum, chunk) => sum + ADTS_HEADER_BYTES + chunk.data.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk, index) => {
    out.set(headers[index], offset);
    out.set(chunk.data, offset + ADTS_HEADER_BYTES);
    offset += ADTS_HEADER_BYTES + chunk.data.byteLength;
  });
  return out;
}
