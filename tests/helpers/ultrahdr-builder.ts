import sharp from 'sharp';

/**
 * Independent Ultra HDR JPEG builder and structural parser for test inputs.
 *
 * Authored from the public file-layout specifications, not from the engine under test:
 * - Ultra HDR / Adobe gain map layout (primary SDR JPEG with a Container directory in its XMP,
 *   a gain map JPEG appended after it carrying the `hdrgm:` metadata),
 * - CIPA DC-007 Multi-Picture Format (MPF index in an APP2 segment of the primary image),
 * - ITU-T T.81 JPEG marker syntax for walking segments and entropy-coded data.
 *
 * Both JPEGs are encoded by sharp, so the pixel payloads are produced by a real JPEG encoder.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const MARKER_PREFIX = 0xff;
const MARKER_LENGTH_BYTES = 2;
const MAX_SEGMENT_PAYLOAD = 0xffff - MARKER_LENGTH_BYTES;
const RST_FIRST = 0xd0;
const RST_LAST = 0xd7;
const TEM = 0x01;

const XMP_NAMESPACE_ID = 'http://ns.adobe.com/xap/1.0/\0';
const MPF_IDENTIFIER = 'MPF\0';
const MPF_IDENTIFIER_BYTES = 4;
const HDRGM_NAMESPACE = 'http://ns.adobe.com/hdr-gain-map/1.0/';

const MPF_TAG_VERSION = 0xb000;
const MPF_TAG_NUMBER_OF_IMAGES = 0xb001;
const MPF_TAG_ENTRIES = 0xb002;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_UNDEFINED = 7;
const TIFF_MAGIC = 42;
const TIFF_HEADER_BYTES = 8;
const IFD_ENTRY_BYTES = 12;
const MP_ENTRY_BYTES = 16;
const MPF_IFD_ENTRY_COUNT = 3;
/** Representative-image flag (bit 29) plus Baseline MP Primary Image type code 0x030000. */
const MP_ATTRIBUTE_PRIMARY = 0x20030000;
/** JPEG data format with undefined type: how the gain map secondary image is flagged. */
const MP_ATTRIBUTE_SECONDARY = 0x00000000;

const GAIN_MAP_JPEG_QUALITY = 90;
const PRIMARY_JPEG_QUALITY = 92;
const UINT16_BYTES = 2;
const UINT32_BYTES = 4;

export interface UltraHdrGainMapMetadata {
  /** log2 of the gain applied at gain map value 0. */
  gainMapMin: number;
  /** log2 of the gain applied at gain map value 255. */
  gainMapMax: number;
  gamma: number;
  offsetSdr: number;
  offsetHdr: number;
}

export interface UltraHdrBuildInput {
  width: number;
  height: number;
  /** 8-bit sRGB base rendition, tightly packed RGB. */
  sdrRgb: Buffer;
  /** 8-bit single channel gain map at the same resolution. */
  gainMap: Buffer;
  metadata: UltraHdrGainMapMetadata;
  /**
   * Also write `hdrgm:GainMapMax` into the primary XMP. Off by default: the Ultra HDR layout keeps
   * the range only in the gain map image's XMP.
   */
  mirrorGainMapMaxInPrimary?: boolean;
  /** Rewrites the gain map XMP text before it is packed, to build malformed or alternative metadata forms. */
  editGainMapXmp?: (xmp: string) => string;
  /**
   * Insert an EXIF APP1 segment into the primary image whose payload carries an embedded thumbnail JPEG
   * immediately followed by a second JPEG (an EOI directly followed by an SOI inside the segment), the
   * way cameras pack a thumbnail next to a preview. A scan for "EOI then SOI" would split the file there.
   */
  exifThumbnailTrap?: boolean;
  /**
   * Place a depth-map-like grayscale JPEG without any hdrgm XMP between the primary image and the gain map,
   * in both the file and the MPF table, as phones that store several auxiliary images do.
   */
  depthMapBeforeGainMap?: boolean;
  /** Raw bytes of one more image stored after the gain map and listed last in the MPF table. */
  trailingImage?: Buffer;
}

/** MP Entry index of the gain map when `depthMapBeforeGainMap` places a depth map ahead of it. */
export const GAIN_MAP_ENTRY_INDEX_WITH_DEPTH_MAP = 2;
/** MP Entry index of the gain map in a plain two-image file. */
export const GAIN_MAP_ENTRY_INDEX_PLAIN = 1;

export interface UltraHdrParts {
  primaryJpeg: Buffer;
  gainMapJpeg: Buffer;
  /** Present when `depthMapBeforeGainMap` was requested. */
  depthJpeg?: Buffer;
  file: Buffer;
}

function xmpPacket(body: string): Buffer {
  const packet = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>${body}<?xpacket end="w"?>`;
  return Buffer.concat([Buffer.from(XMP_NAMESPACE_ID, 'ascii'), Buffer.from(packet, 'utf8')]);
}

function gainMapXmpText(meta: UltraHdrGainMapMetadata): string {
  return (
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:hdrgm="${HDRGM_NAMESPACE}" hdrgm:Version="1.0"` +
      ` hdrgm:GainMapMin="${meta.gainMapMin.toFixed(6)}" hdrgm:GainMapMax="${meta.gainMapMax.toFixed(6)}"` +
      ` hdrgm:Gamma="${meta.gamma.toFixed(6)}" hdrgm:OffsetSDR="${meta.offsetSdr.toFixed(6)}"` +
      ` hdrgm:OffsetHDR="${meta.offsetHdr.toFixed(6)}" hdrgm:HDRCapacityMin="${meta.gainMapMin.toFixed(6)}"` +
      ` hdrgm:HDRCapacityMax="${meta.gainMapMax.toFixed(6)}" hdrgm:BaseRenditionIsHDR="False"/>` +
      `</rdf:RDF></x:xmpmeta>`
  );
}

function gainMapXmp(meta: UltraHdrGainMapMetadata, edit?: (xmp: string) => string): Buffer {
  const text = gainMapXmpText(meta);
  return xmpPacket(edit ? edit(text) : text);
}

/** Primary XMP: the Container directory describing both items, plus the `hdrgm:` version marker. */
function primaryXmp(gainMapLength: number, meta: UltraHdrGainMapMetadata, mirrorGainMapMax: boolean): Buffer {
  const mirrored = mirrorGainMapMax ? ` hdrgm:GainMapMax="${meta.gainMapMax.toFixed(6)}"` : '';
  return xmpPacket(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
      `<rdf:Description rdf:about="" xmlns:Container="http://ns.google.com/photos/1.0/container/"` +
      ` xmlns:Item="http://ns.google.com/photos/1.0/container/item/" xmlns:hdrgm="${HDRGM_NAMESPACE}"` +
      ` hdrgm:Version="1.0"${mirrored}>` +
      `<Container:Directory><rdf:Seq>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>` +
      `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg"` +
      ` Item:Length="${gainMapLength}"/></rdf:li>` +
      `</rdf:Seq></Container:Directory></rdf:Description></rdf:RDF></x:xmpmeta>`
  );
}

function app1Segment(payload: Buffer): Buffer {
  return appSegment(APP1, payload);
}

function appSegment(marker: number, payload: Buffer): Buffer {
  if (payload.length > MAX_SEGMENT_PAYLOAD) throw new Error('APP segment payload exceeds 65533 bytes');
  const header = Buffer.from([MARKER_PREFIX, marker, 0, 0]);
  header.writeUInt16BE(payload.length + MARKER_LENGTH_BYTES, 2);
  return Buffer.concat([header, payload]);
}

const EXIF_IDENTIFIER = 'Exif\0\0';
const EXIF_TAG_JPEG_INTERCHANGE_FORMAT = 0x0201;
const EXIF_TAG_JPEG_INTERCHANGE_FORMAT_LENGTH = 0x0202;
const THUMBNAIL_EDGE = 8;
const THUMBNAIL_QUALITY = 70;
const THUMBNAIL_GREY = 90;
const PREVIEW_GREY = 200;

function tinyJpeg(grey: number): Promise<Buffer> {
  return sharp({ create: { width: THUMBNAIL_EDGE, height: THUMBNAIL_EDGE, channels: 3, background: { r: grey, g: grey, b: grey } } })
    .jpeg({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
}

/**
 * EXIF APP1 payload (little-endian TIFF, empty IFD0, IFD1 pointing at a thumbnail JPEG) whose thumbnail
 * is directly followed by another complete JPEG, so the bytes FF D9 FF D8 occur inside the segment.
 */
async function exifThumbnailPayload(): Promise<Buffer> {
  const thumbnail = await tinyJpeg(THUMBNAIL_GREY);
  const preview = await tinyJpeg(PREVIEW_GREY);
  const ifd0Offset = TIFF_HEADER_BYTES;
  const ifd1Offset = ifd0Offset + UINT16_BYTES + UINT32_BYTES;
  const ifd1Entries = 2;
  const thumbnailOffset = ifd1Offset + UINT16_BYTES + ifd1Entries * IFD_ENTRY_BYTES + UINT32_BYTES;
  const tiff = Buffer.alloc(thumbnailOffset);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(TIFF_MAGIC, 2);
  tiff.writeUInt32LE(ifd0Offset, 4);
  tiff.writeUInt16LE(0, ifd0Offset); // IFD0 carries no entries
  tiff.writeUInt32LE(ifd1Offset, ifd0Offset + UINT16_BYTES);
  let pos = ifd1Offset;
  tiff.writeUInt16LE(ifd1Entries, pos);
  pos += UINT16_BYTES;
  tiff.writeUInt16LE(EXIF_TAG_JPEG_INTERCHANGE_FORMAT, pos);
  tiff.writeUInt16LE(TIFF_TYPE_LONG, pos + 2);
  tiff.writeUInt32LE(1, pos + 4);
  tiff.writeUInt32LE(thumbnailOffset, pos + 8);
  pos += IFD_ENTRY_BYTES;
  tiff.writeUInt16LE(EXIF_TAG_JPEG_INTERCHANGE_FORMAT_LENGTH, pos);
  tiff.writeUInt16LE(TIFF_TYPE_LONG, pos + 2);
  tiff.writeUInt32LE(1, pos + 4);
  tiff.writeUInt32LE(thumbnail.length, pos + 8);
  return Buffer.concat([Buffer.from(EXIF_IDENTIFIER, 'binary'), tiff, thumbnail, preview]);
}

const DEPTH_MAP_QUALITY = 85;
const DEPTH_MAP_LEVELS = 256;

/** A horizontal ramp, grayscale JPEG with no XMP: stands in for a depth map next to the gain map. */
function depthMapJpeg(width: number, height: number): Promise<Buffer> {
  const ramp = Buffer.alloc(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) ramp[y * width + x] = Math.floor((x * (DEPTH_MAP_LEVELS - 1)) / Math.max(1, width - 1));
  }
  return sharp(ramp, { raw: { width, height, channels: 1 } }).toColourspace('b-w').jpeg({ quality: DEPTH_MAP_QUALITY }).toBuffer();
}

/** Offset just after SOI and an optional leading JFIF APP0 segment: where extra APPn data goes. */
function insertionOffset(jpeg: Buffer): number {
  if (jpeg[0] !== MARKER_PREFIX || jpeg[1] !== SOI) throw new Error('not a JPEG stream');
  let pos = 2;
  if (jpeg[pos] === MARKER_PREFIX && jpeg[pos + 1] === APP0) {
    pos += 2 + jpeg.readUInt16BE(pos + 2);
  }
  return pos;
}

function insertSegments(jpeg: Buffer, segments: readonly Buffer[]): Buffer {
  const at = insertionOffset(jpeg);
  return Buffer.concat([jpeg.subarray(0, at), ...segments, jpeg.subarray(at)]);
}

/** MPF APP2 payload ("MPF\0" + TIFF structure). Offsets in entries are relative to the TIFF header. */
function mpfPayload(primarySize: number, secondaries: ReadonlyArray<{ size: number; offsetFromTiff: number }>): Buffer {
  const imageCount = 1 + secondaries.length;
  const entriesOffset = TIFF_HEADER_BYTES + UINT16_BYTES + MPF_IFD_ENTRY_COUNT * IFD_ENTRY_BYTES + UINT32_BYTES;
  const tiff = Buffer.alloc(entriesOffset + imageCount * MP_ENTRY_BYTES);
  tiff.write('MM', 0, 'ascii'); // big-endian, as written by phone cameras
  tiff.writeUInt16BE(TIFF_MAGIC, 2);
  tiff.writeUInt32BE(TIFF_HEADER_BYTES, 4);
  let pos = TIFF_HEADER_BYTES;
  tiff.writeUInt16BE(MPF_IFD_ENTRY_COUNT, pos);
  pos += UINT16_BYTES;

  tiff.writeUInt16BE(MPF_TAG_VERSION, pos);
  tiff.writeUInt16BE(TIFF_TYPE_UNDEFINED, pos + 2);
  tiff.writeUInt32BE(UINT32_BYTES, pos + 4);
  tiff.write('0100', pos + 8, 'ascii');
  pos += IFD_ENTRY_BYTES;

  tiff.writeUInt16BE(MPF_TAG_NUMBER_OF_IMAGES, pos);
  tiff.writeUInt16BE(TIFF_TYPE_LONG, pos + 2);
  tiff.writeUInt32BE(1, pos + 4);
  tiff.writeUInt32BE(imageCount, pos + 8);
  pos += IFD_ENTRY_BYTES;

  tiff.writeUInt16BE(MPF_TAG_ENTRIES, pos);
  tiff.writeUInt16BE(TIFF_TYPE_UNDEFINED, pos + 2);
  tiff.writeUInt32BE(imageCount * MP_ENTRY_BYTES, pos + 4);
  tiff.writeUInt32BE(entriesOffset, pos + 8);
  pos += IFD_ENTRY_BYTES;

  tiff.writeUInt32BE(0, pos); // no next IFD
  pos += UINT32_BYTES;

  tiff.writeUInt32BE(MP_ATTRIBUTE_PRIMARY, pos);
  tiff.writeUInt32BE(primarySize, pos + 4);
  tiff.writeUInt32BE(0, pos + 8); // the primary image offset is always 0
  pos += MP_ENTRY_BYTES;

  for (const secondary of secondaries) {
    tiff.writeUInt32BE(MP_ATTRIBUTE_SECONDARY, pos);
    tiff.writeUInt32BE(secondary.size, pos + 4);
    tiff.writeUInt32BE(secondary.offsetFromTiff, pos + 8);
    pos += MP_ENTRY_BYTES;
  }
  return Buffer.concat([Buffer.from(MPF_IDENTIFIER, 'ascii'), tiff]);
}

/** Builds an Ultra HDR JPEG: primary SDR JPEG (XMP container + MPF) followed by the gain map JPEG. */
export async function buildUltraHdrJpeg(input: UltraHdrBuildInput): Promise<UltraHdrParts> {
  const { width, height } = input;
  if (input.sdrRgb.length !== width * height * 3) throw new Error('sdrRgb must be tightly packed RGB');
  if (input.gainMap.length !== width * height) throw new Error('gainMap must be one byte per pixel');

  // A monochrome gain map is a single-component JPEG, so the colourspace must be b-w explicitly.
  const gainMapBase = await sharp(input.gainMap, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .jpeg({ quality: GAIN_MAP_JPEG_QUALITY })
    .toBuffer();
  const gainMapJpeg = insertSegments(gainMapBase, [app1Segment(gainMapXmp(input.metadata, input.editGainMapXmp))]);

  const depthJpeg = input.depthMapBeforeGainMap === true ? await depthMapJpeg(width, height) : undefined;

  const primaryBase = await sharp(input.sdrRgb, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: PRIMARY_JPEG_QUALITY })
    .toBuffer();
  const xmpSegment = app1Segment(primaryXmp(gainMapJpeg.length, input.metadata, input.mirrorGainMapMaxInPrimary === true));
  const exifSegments = input.exifThumbnailTrap === true ? [app1Segment(await exifThumbnailPayload())] : [];
  const leadingLength = [...exifSegments, xmpSegment].reduce((sum, segment) => sum + segment.length, 0);
  // The MPF segment has a fixed size, so the final primary size is known before it is written.
  const stored = [...(depthJpeg ? [depthJpeg] : []), gainMapJpeg, ...(input.trailingImage ? [input.trailingImage] : [])];
  const secondarySizes = stored.map((image) => image.length);
  const mpfLength = MARKER_LENGTH_BYTES + MARKER_LENGTH_BYTES + mpfPayload(0, secondarySizes.map((size) => ({ size, offsetFromTiff: 0 }))).length;
  const primarySize = primaryBase.length + leadingLength + mpfLength;
  const mpfSegmentStart = insertionOffset(primaryBase) + leadingLength;
  const tiffStart = mpfSegmentStart + MARKER_LENGTH_BYTES + MARKER_LENGTH_BYTES + MPF_IDENTIFIER_BYTES;
  let nextOffset = primarySize - tiffStart;
  const secondaries = secondarySizes.map((size) => {
    const entry = { size, offsetFromTiff: nextOffset };
    nextOffset += size;
    return entry;
  });
  const mpfSegment = appSegment(APP2, mpfPayload(primarySize, secondaries));
  if (mpfSegment.length !== mpfLength) throw new Error('MPF segment size changed between passes');

  const primaryJpeg = insertSegments(primaryBase, [...exifSegments, xmpSegment, mpfSegment]);
  if (primaryJpeg.length !== primarySize) throw new Error('primary size mismatch');
  const file = Buffer.concat([primaryJpeg, ...stored]);
  return { primaryJpeg, gainMapJpeg, depthJpeg, file };
}

// ----------------------------------------------------------------------------
// Independent structural parser (JPEG segment walk + MPF + XMP), used as the oracle.
// ----------------------------------------------------------------------------

export interface JpegSegment {
  marker: number;
  /** Offset of the 0xFF prefix. */
  offset: number;
  /** Segment payload (without the length field); empty for standalone markers. */
  payload: Buffer;
}

export interface JpegStream {
  start: number;
  /** Exclusive end: the offset just after the EOI marker. */
  end: number;
  segments: JpegSegment[];
}

/** Walks one JPEG stream starting at `start` (must be SOI) to its EOI, following entropy-coded data. */
export function walkJpeg(buf: Buffer, start: number): JpegStream {
  if (buf[start] !== MARKER_PREFIX || buf[start + 1] !== SOI) throw new Error(`no SOI at offset ${start}`);
  const segments: JpegSegment[] = [{ marker: SOI, offset: start, payload: Buffer.alloc(0) }];
  let pos = start + 2;
  for (;;) {
    while (pos < buf.length && buf[pos] === MARKER_PREFIX && buf[pos + 1] === MARKER_PREFIX) pos++;
    if (pos + 1 >= buf.length || buf[pos] !== MARKER_PREFIX) throw new Error(`expected a marker at offset ${pos}`);
    const marker = buf[pos + 1];
    if (marker === EOI) {
      segments.push({ marker, offset: pos, payload: Buffer.alloc(0) });
      return { start, end: pos + 2, segments };
    }
    const standalone = marker === TEM || (marker >= RST_FIRST && marker <= RST_LAST);
    if (standalone) {
      segments.push({ marker, offset: pos, payload: Buffer.alloc(0) });
      pos += 2;
      continue;
    }
    const length = buf.readUInt16BE(pos + 2);
    segments.push({ marker, offset: pos, payload: buf.subarray(pos + 4, pos + 2 + length) });
    pos += 2 + length;
    if (marker === SOS) {
      // Skip entropy-coded data: stuffed 0xFF00 and restart markers belong to the scan.
      while (pos + 1 < buf.length) {
        if (buf[pos] === MARKER_PREFIX) {
          const next = buf[pos + 1];
          const inScan = next === 0x00 || (next >= RST_FIRST && next <= RST_LAST) || next === MARKER_PREFIX;
          if (!inScan) break;
          pos += next === MARKER_PREFIX ? 1 : 2;
        } else {
          pos++;
        }
      }
    }
  }
}

export interface MpEntry {
  attribute: number;
  size: number;
  /** Offset relative to the MPF TIFF header, as stored. */
  dataOffset: number;
  /** Absolute offset in the file (the primary image resolves to 0). */
  absoluteOffset: number;
}

export interface MpfIndex {
  version: string;
  numberOfImages: number;
  entries: MpEntry[];
}

/** Parses the CIPA DC-007 MP Index IFD out of an APP2 "MPF\0" payload. */
export function parseMpf(payload: Buffer, tiffAbsoluteOffset: number): MpfIndex {
  if (payload.toString('ascii', 0, MPF_IDENTIFIER_BYTES) !== MPF_IDENTIFIER) throw new Error('not an MPF payload');
  const tiff = payload.subarray(MPF_IDENTIFIER_BYTES);
  const order = tiff.toString('ascii', 0, 2);
  if (order !== 'MM' && order !== 'II') throw new Error('bad MPF byte order');
  const big = order === 'MM';
  const u16 = (at: number) => (big ? tiff.readUInt16BE(at) : tiff.readUInt16LE(at));
  const u32 = (at: number) => (big ? tiff.readUInt32BE(at) : tiff.readUInt32LE(at));
  if (u16(2) !== TIFF_MAGIC) throw new Error('bad TIFF magic in MPF');
  const ifd = u32(4);
  const count = u16(ifd);
  let version = '';
  let numberOfImages = 0;
  let entriesOffset = -1;
  let entriesBytes = 0;
  for (let i = 0; i < count; i++) {
    const at = ifd + UINT16_BYTES + i * IFD_ENTRY_BYTES;
    const tag = u16(at);
    if (tag === MPF_TAG_VERSION) version = tiff.toString('ascii', at + 8, at + 12);
    if (tag === MPF_TAG_NUMBER_OF_IMAGES) numberOfImages = u32(at + 8);
    if (tag === MPF_TAG_ENTRIES) {
      entriesBytes = u32(at + 4);
      entriesOffset = u32(at + 8);
    }
  }
  if (entriesOffset < 0) throw new Error('MPF has no MP Entry tag');
  const entries: MpEntry[] = [];
  for (let at = entriesOffset; at < entriesOffset + entriesBytes; at += MP_ENTRY_BYTES) {
    const dataOffset = u32(at + 8);
    entries.push({
      attribute: u32(at),
      size: u32(at + 4),
      dataOffset,
      absoluteOffset: dataOffset === 0 ? 0 : tiffAbsoluteOffset + dataOffset,
    });
  }
  return { version, numberOfImages, entries };
}

export interface UltraHdrStructure {
  primary: JpegStream;
  secondary: JpegStream;
  mpf: MpfIndex;
  /** Every XMP packet found in either image's APP1 segments. */
  primaryXmp: string;
  gainMapXmp: string;
  primaryJpeg: Buffer;
  gainMapJpeg: Buffer;
}

function xmpOf(buf: Buffer, stream: JpegStream): string {
  const id = Buffer.from(XMP_NAMESPACE_ID, 'ascii');
  const parts = stream.segments
    .filter((s) => s.marker === APP1 && s.payload.subarray(0, id.length).equals(id))
    .map((s) => s.payload.subarray(id.length).toString('utf8'));
  return parts.join('\n');
}

/**
 * Independent parse of an Ultra HDR file: walks both JPEG streams marker by marker, resolves the MPF
 * entries to absolute offsets and checks they land on the SOI of each image. `gainMapEntryIndex` is the
 * MP Entry the fixture wrote as the gain map.
 */
export function parseUltraHdrStructure(file: Buffer, gainMapEntryIndex = GAIN_MAP_ENTRY_INDEX_PLAIN): UltraHdrStructure {
  const primary = walkJpeg(file, 0);
  const mpfSegment = primary.segments.find(
    (s) => s.marker === APP2 && s.payload.toString('ascii', 0, MPF_IDENTIFIER_BYTES) === MPF_IDENTIFIER
  );
  if (!mpfSegment) throw new Error('primary image has no MPF APP2 segment');
  const tiffAbsolute = mpfSegment.offset + MARKER_LENGTH_BYTES + MARKER_LENGTH_BYTES + MPF_IDENTIFIER_BYTES;
  const mpf = parseMpf(mpfSegment.payload, tiffAbsolute);
  if (mpf.entries.length < 2) throw new Error('MPF index lists fewer than two images');
  if (gainMapEntryIndex < 1 || gainMapEntryIndex >= mpf.entries.length) throw new Error('gain map entry index is not in the MPF table');
  // The caller knows which entry its fixture wrote as the gain map; no selection rule is re-derived here.
  const secondary = walkJpeg(file, mpf.entries[gainMapEntryIndex].absoluteOffset);
  return {
    primary,
    secondary,
    mpf,
    primaryXmp: xmpOf(file, primary),
    gainMapXmp: xmpOf(file, secondary),
    primaryJpeg: file.subarray(primary.start, primary.end),
    gainMapJpeg: file.subarray(secondary.start, secondary.end),
  };
}

/** Reads an `hdrgm:` attribute value from an XMP packet. */
export function readHdrgmAttribute(xmp: string, name: string): string | null {
  const match = new RegExp(`hdrgm:${name}="([^"]*)"`).exec(xmp);
  return match ? match[1] : null;
}
