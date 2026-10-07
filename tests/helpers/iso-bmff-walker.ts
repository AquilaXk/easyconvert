/**
 * Independent ISO/IEC 14496-12 box walker for tests. It is written from the specification and shares no code
 * with the engines under test, so a muxer's structure is judged by a second reader, not by itself.
 */

export interface IsoBox {
  type: string;
  /** Offset of the box header in the file. */
  start: number;
  /** Total size in bytes, header included. */
  size: number;
  /** Offset of the first payload byte. */
  payloadStart: number;
  /** Offset one past the last byte. */
  end: number;
}

const MAX_BOXES = 100_000;

/** Boxes whose payload is nothing but child boxes. */
const PLAIN_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'mvex', 'moof', 'traf']);

const BOX_HEADER_BYTES = 8;
const LARGE_BOX_HEADER_BYTES = 16;
const VISUAL_SAMPLE_ENTRY_BYTES = 78;
const AUDIO_SAMPLE_ENTRY_BYTES = 28;
const STSD_HEADER_BYTES = 8;

function fourcc(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** Lists the sibling boxes between `start` and `end`; throws when a size runs past `end`. */
export function listBoxes(data: Uint8Array, start = 0, end = data.length): IsoBox[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const boxes: IsoBox[] = [];
  let offset = start;
  while (offset < end) {
    if (offset + BOX_HEADER_BYTES > end) throw new Error(`truncated box header at ${offset}`);
    let size = view.getUint32(offset);
    let headerBytes = BOX_HEADER_BYTES;
    if (size === 1) {
      size = Number(view.getBigUint64(offset + BOX_HEADER_BYTES));
      headerBytes = LARGE_BOX_HEADER_BYTES;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerBytes || offset + size > end) throw new Error(`box at ${offset} has size ${size}, past ${end}`);
    boxes.push({ type: fourcc(data, offset + 4), start: offset, size, payloadStart: offset + headerBytes, end: offset + size });
    offset += size;
    if (boxes.length > MAX_BOXES) throw new Error('too many boxes');
  }
  return boxes;
}

/** Children of a plain container box. */
export function childBoxes(data: Uint8Array, box: IsoBox): IsoBox[] {
  if (!PLAIN_CONTAINERS.has(box.type)) throw new Error(`${box.type} is not a plain container`);
  return listBoxes(data, box.payloadStart, box.end);
}

/** Follows a path of plain-container types from `boxes`, returning every box matching the final type. */
export function findPath(data: Uint8Array, boxes: IsoBox[], path: string[]): IsoBox[] {
  const [head, ...rest] = path;
  const matches = boxes.filter((box) => box.type === head);
  if (rest.length === 0) return matches;
  return matches.flatMap((box) => findPath(data, childBoxes(data, box), rest));
}

export interface SampleEntry {
  /** Sample entry four-character code, such as avc1, vp09, av01, mp4a. */
  type: string;
  box: IsoBox;
  /** Child boxes of the entry (avcC, vpcC, av1C, esds, ...). */
  children: IsoBox[];
}

/** Sample entries of one stsd box; `kind` selects the fixed entry header that precedes the child boxes. */
export function sampleEntries(data: Uint8Array, stsd: IsoBox, kind: 'visual' | 'audio'): SampleEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = view.getUint32(stsd.payloadStart + 4);
  const entries = listBoxes(data, stsd.payloadStart + STSD_HEADER_BYTES, stsd.end);
  if (entries.length !== count) throw new Error(`stsd declares ${count} entries, holds ${entries.length}`);
  const fixed = kind === 'visual' ? VISUAL_SAMPLE_ENTRY_BYTES : AUDIO_SAMPLE_ENTRY_BYTES;
  return entries.map((box) => ({
    type: box.type,
    box,
    children: listBoxes(data, box.payloadStart + fixed, box.end),
  }));
}

export function payloadOf(data: Uint8Array, box: IsoBox): Uint8Array {
  return data.subarray(box.payloadStart, box.end);
}

/** `ftyp` major brand and compatible brands. */
export function readFtyp(data: Uint8Array): { majorBrand: string; compatibleBrands: string[] } {
  const ftyp = listBoxes(data).find((box) => box.type === 'ftyp');
  if (!ftyp) throw new Error('no ftyp box');
  const brands: string[] = [];
  for (let offset = ftyp.payloadStart + 8; offset + 4 <= ftyp.end; offset += 4) brands.push(fourcc(data, offset));
  return { majorBrand: fourcc(data, ftyp.payloadStart), compatibleBrands: brands };
}

export interface WalkedTrack {
  handler: string;
  stsd: IsoBox;
  stbl: IsoBox[];
  entries: SampleEntry[];
  sampleCount: number;
}

/** Every track of the movie with its handler, sample entries and sample count read from stsz. */
export function walkTracks(data: Uint8Array): WalkedTrack[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const top = listBoxes(data);
  const traks = findPath(data, top, ['moov', 'trak']);
  return traks.map((trak) => {
    const mdia = findPath(data, childBoxes(data, trak), ['mdia'])[0];
    const hdlr = findPath(data, childBoxes(data, mdia), ['hdlr'])[0];
    const handler = fourcc(data, hdlr.payloadStart + 8);
    const stblBoxes = findPath(data, childBoxes(data, mdia), ['minf', 'stbl']);
    const stblChildren = childBoxes(data, stblBoxes[0]);
    const stsd = stblChildren.find((box) => box.type === 'stsd');
    const stsz = stblChildren.find((box) => box.type === 'stsz');
    if (!stsd || !stsz) throw new Error('track without stsd or stsz');
    return {
      handler,
      stsd,
      stbl: stblChildren,
      entries: sampleEntries(data, stsd, handler === 'vide' ? 'visual' : 'audio'),
      sampleCount: view.getUint32(stsz.payloadStart + 8),
    };
  });
}

/** The avcC payload of the first H.264 track, read from a reference-authored file. */
export function extractAvcC(data: Uint8Array): Uint8Array {
  for (const track of walkTracks(data)) {
    for (const entry of track.entries) {
      const avcC = entry.children.find((child) => child.type === 'avcC');
      if (avcC) return payloadOf(data, avcC).slice();
    }
  }
  throw new Error('no avcC box in the file');
}

/** Reads an MPEG-4 descriptor length: seven bits per byte while the high bit is set. */
function descriptorLength(bytes: Uint8Array, at: number): { length: number; next: number } {
  let length = 0;
  let cursor = at;
  for (;;) {
    const byte = bytes[cursor++];
    length = length * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) return { length, next: cursor };
  }
}

/** The object type indication and the AudioSpecificConfig of an esds payload (ISO/IEC 14496-1 7.2.6). */
export function readEsds(payload: Uint8Array): { oti: number; streamType: number; asc: Uint8Array } {
  let at = 4; // version and flags
  if (payload[at++] !== 0x03) throw new Error('esds does not start with an ES_Descriptor');
  at = descriptorLength(payload, at).next;
  at += 3; // ES_ID and flags
  if (payload[at++] !== 0x04) throw new Error('esds has no DecoderConfigDescriptor');
  at = descriptorLength(payload, at).next;
  const oti = payload[at];
  const streamType = payload[at + 1];
  at += 1 + 1 + 3 + 4 + 4;
  if (payload[at++] !== 0x05) throw new Error('esds has no DecoderSpecificInfo');
  const { length, next } = descriptorLength(payload, at);
  return { oti, streamType, asc: payload.slice(next, next + length) };
}
