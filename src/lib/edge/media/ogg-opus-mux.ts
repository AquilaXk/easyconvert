/**
 * Ogg Opus muxer (RFC 3533 pages, RFC 7845 encapsulation) for the packets of a WebCodecs Opus encoder.
 *
 * The identification header is the OpusHead the encoder reported, written verbatim, so the pre-skip, input
 * sample rate and channel mapping are the encoder's own. Granule positions are counted from the packets
 * themselves: every Opus packet states its frame size and frame count in its TOC byte (RFC 6716 3.1), so the
 * 48 kHz sample count of each packet is read from the packet, not assumed. An empty stream, a packet whose TOC
 * is not valid, or a missing OpusHead throws EdgeUnsupportedError.
 */

import { EdgeUnsupportedError } from '../workers/worker-errors';
import type { EncodedMediaChunk } from './media-types';

const OGG_PAGE_HEADER_BYTES = 27;
const OGG_MAX_SEGMENTS = 255;
const OGG_SEGMENT_BYTES = 255;
const OGG_FLAG_BOS = 0x02;
const OGG_FLAG_EOS = 0x04;
const OGG_STREAM_SERIAL = 0x4f505553; // 'OPUS'
/** A page is closed once its packets hold this many 48 kHz samples: one second, which bounds seek and latency cost. */
const OGG_PAGE_TARGET_SAMPLES = 48_000;
const OPUS_HEAD_MAGIC = 'OpusHead';
const OPUS_HEAD_MIN_BYTES = 19;
const OPUS_HEAD_VERSION_OFFSET = 8;
/** The version byte's major nibble must be 0 (RFC 7845 5.1). */
const OPUS_HEAD_MAJOR_VERSION_MASK = 0xf0;
/** The 48 kHz sample count an Opus packet may hold at most: 120 ms. */
const OPUS_MAX_PACKET_SAMPLES = 5760;
const OPUS_MAX_FRAMES_PER_PACKET = 48;
const OPUS_FRAME_COUNT_MASK = 0x3f;
const VENDOR = 'EasyConvert WebCodecs Engine';
const ENCODER_COMMENT = 'ENCODER=EasyConvert WebCodecs Native Opus';

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`Ogg Opus output: ${message}; the server engine converts this file.`);
}

/** RFC 3533 CRC-32: polynomial 0x04C11DB7, no reflection, zero initial value and no final XOR. */
const OGG_CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let register = (i << 24) >>> 0;
  for (let bit = 0; bit < 8; bit++) {
    register = (register & 0x80000000) !== 0 ? ((register << 1) ^ 0x04c11db7) >>> 0 : (register << 1) >>> 0;
  }
  OGG_CRC32_TABLE[i] = register;
}

function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) {
    crc = ((crc << 8) ^ OGG_CRC32_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  }
  return crc >>> 0;
}

/** Lacing values of `payload`: full 255-byte segments, then the remainder, which is 0 when the size is a multiple of 255. */
function lacingSegments(length: number): number {
  return Math.floor(length / OGG_SEGMENT_BYTES) + 1;
}

/** One Ogg page holding the complete `packets` (RFC 3533 6); `granulePos` is that of the last packet. */
function createOggPage(
  packets: readonly Uint8Array[],
  headerType: number,
  granulePos: bigint,
  sequenceNum: number,
  serial: number
): Uint8Array {
  const segments: number[] = [];
  let payloadLength = 0;
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= OGG_SEGMENT_BYTES) {
      segments.push(OGG_SEGMENT_BYTES);
      remaining -= OGG_SEGMENT_BYTES;
    }
    segments.push(remaining);
    payloadLength += packet.length;
  }
  if (segments.length > OGG_MAX_SEGMENTS) throw refuse(`${packets.length} packets of ${payloadLength} bytes do not fit one Ogg page`);

  const headerSize = OGG_PAGE_HEADER_BYTES + segments.length;
  const page = new Uint8Array(headerSize + payloadLength);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // 'OggS'
  page[4] = 0; // stream structure version
  page[5] = headerType;
  view.setBigInt64(6, granulePos, true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequenceNum, true);
  page[26] = segments.length;
  page.set(segments, OGG_PAGE_HEADER_BYTES);
  let offset = headerSize;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

/** One Ogg page holding one complete packet. */
export function createOggPageTyped(
  payload: Uint8Array,
  headerType: number,
  granulePos: bigint,
  sequenceNum: number,
  serial: number
): Uint8Array {
  if (lacingSegments(payload.length) > OGG_MAX_SEGMENTS) throw refuse(`a ${payload.length}-byte packet does not fit one Ogg page`);
  return createOggPage([payload], headerType, granulePos, sequenceNum, serial);
}

/** 48 kHz samples per frame for TOC configurations 0..31 (RFC 6716 3.1 Table 2). */
const FRAME_SAMPLES_BY_CONFIG: readonly number[] = [
  // SILK-only: 10, 20, 40 and 60 ms for narrowband, mediumband and wideband
  480, 960, 1920, 2880, 480, 960, 1920, 2880, 480, 960, 1920, 2880,
  // Hybrid: 10 and 20 ms for super-wideband and fullband
  480, 960, 480, 960,
  // CELT-only: 2.5, 5, 10 and 20 ms for narrowband, wideband, super-wideband and fullband
  120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960, 120, 240, 480, 960,
];

/** The 48 kHz sample count of one Opus packet, from its TOC byte and, for code 3, its frame count byte. */
export function opusPacketSamples(packet: Uint8Array): number {
  if (packet.byteLength === 0) throw refuse('an Opus packet is empty');
  const toc = packet[0];
  const frameSamples = FRAME_SAMPLES_BY_CONFIG[toc >>> 3];
  const code = toc & 3;
  let frames: number;
  if (code === 0) {
    frames = 1;
  } else if (code === 1 || code === 2) {
    frames = 2;
  } else {
    if (packet.byteLength < 2) throw refuse('an Opus packet of frame count code 3 has no frame count byte');
    frames = packet[1] & OPUS_FRAME_COUNT_MASK;
  }
  const samples = frames * frameSamples;
  if (frames < 1 || frames > OPUS_MAX_FRAMES_PER_PACKET || samples > OPUS_MAX_PACKET_SAMPLES) {
    throw refuse('an Opus packet declares a duration beyond 120 ms');
  }
  return samples;
}

function opusTagsPacket(): Uint8Array {
  const vendor = new TextEncoder().encode(VENDOR);
  const comment = new TextEncoder().encode(ENCODER_COMMENT);
  const out = new Uint8Array(8 + 4 + vendor.length + 4 + 4 + comment.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode('OpusTags'), 0);
  view.setUint32(8, vendor.length, true);
  out.set(vendor, 12);
  view.setUint32(12 + vendor.length, 1, true);
  view.setUint32(16 + vendor.length, comment.length, true);
  out.set(comment, 20 + vendor.length);
  return out;
}

/** Writes an Ogg Opus file from encoded Opus packets and the OpusHead the encoder reported. */
export function muxOggOpus(chunks: EncodedMediaChunk[], opusHead: Uint8Array | undefined): Uint8Array {
  if (!opusHead || opusHead.byteLength === 0) throw refuse('the encoder reported no OpusHead decoder configuration record');
  if (chunks.length === 0) throw refuse('there are no packets to write');
  const magic = String.fromCharCode(...opusHead.subarray(0, OPUS_HEAD_MAGIC.length));
  if (
    opusHead.byteLength < OPUS_HEAD_MIN_BYTES ||
    magic !== OPUS_HEAD_MAGIC ||
    (opusHead[OPUS_HEAD_VERSION_OFFSET] & OPUS_HEAD_MAJOR_VERSION_MASK) !== 0
  ) {
    throw refuse('the encoder reported a decoder configuration that is not an OpusHead');
  }

  const pages: Uint8Array[] = [
    createOggPageTyped(opusHead, OGG_FLAG_BOS, 0n, 0, OGG_STREAM_SERIAL),
    createOggPageTyped(opusTagsPacket(), 0, 0n, 1, OGG_STREAM_SERIAL),
  ];
  // RFC 7845 4: the granule position is the number of 48 kHz samples the decoder has produced so far. The pre-skip
  // is part of that count (the decoder drops it from its output), so the muxer starts at zero and does not add it.
  // A page holds whole packets and carries the granule position of the last one: it closes at one second of audio,
  // or before the packet that would need more than 255 lacing values.
  let granule = 0n;
  let pageSamples = 0;
  let pageSegments = 0;
  let pagePackets: Uint8Array[] = [];
  const closePage = (isLast: boolean): void => {
    pages.push(createOggPage(pagePackets, isLast ? OGG_FLAG_EOS : 0, granule, pages.length, OGG_STREAM_SERIAL));
    pagePackets = [];
    pageSamples = 0;
    pageSegments = 0;
  };
  chunks.forEach((chunk, index) => {
    const samples = opusPacketSamples(chunk.data);
    const segments = lacingSegments(chunk.data.length);
    if (segments > OGG_MAX_SEGMENTS) throw refuse(`a ${chunk.data.length}-byte packet does not fit one Ogg page`);
    if (pagePackets.length > 0 && pageSegments + segments > OGG_MAX_SEGMENTS) closePage(false);
    pagePackets.push(chunk.data);
    pageSegments += segments;
    pageSamples += samples;
    granule += BigInt(samples);
    if (pageSamples >= OGG_PAGE_TARGET_SAMPLES || index === chunks.length - 1) closePage(index === chunks.length - 1);
  });

  const out = new Uint8Array(pages.reduce((sum, page) => sum + page.byteLength, 0));
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.byteLength;
  }
  return out;
}
