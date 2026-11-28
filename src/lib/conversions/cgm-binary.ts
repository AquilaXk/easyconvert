import { CadGeometryUnavailableError } from '../types';

/**
 * The binary encoding of a Computer Graphics Metafile (ISO/IEC 8632-3): the element framing and the parameter types the writers use.
 * The layouts follow the standard and the reader of the office suite (`filter/source/graphicfilter/icgm`, MPL), and the MIT-licensed
 * `twenzel/CGM` writer (github.com/twenzel/CGM, `DefaultBinaryWriter.WriteHeader`, `CellArray.WriteColorList`) for the points the
 * standard leaves to a reading, such as the word boundary at the end of a packed row of cells.
 * Everything is big-endian.
 */

/** Element classes of ISO 8632-1 clause 8 that the writers use. */
export const CGM_CLASS = { delimiter: 0, metafileDescriptor: 1, pictureDescriptor: 2, control: 3, primitive: 4, attribute: 5 } as const;

/** Element ids, by class. */
export const CGM_ID = {
  beginMetafile: 1,
  endMetafile: 2,
  beginPicture: 3,
  beginPictureBody: 4,
  endPicture: 5,
  metafileVersion: 1,
  metafileDescription: 2,
  vdcType: 3,
  integerPrecision: 4,
  colourPrecision: 7,
  colourValueExtent: 10,
  metafileElementList: 11,
  colourMode: 2,
  lineWidthMode: 3,
  vdcExtent: 6,
  backgroundColour: 7,
  vdcIntegerPrecision: 1,
  polyline: 1,
  polygon: 7,
  polygonSet: 8,
  cellArray: 9,
  lineWidth: 3,
  lineColour: 4,
  lineCap: 37,
  lineJoin: 38,
  interiorStyle: 22,
  fillColour: 23,
} as const;

/** A parameter list of up to 30 octets is in the 5 bits of the command header; 31 there says that a length word follows (ISO 8632-3 clause 5.2). */
const SHORT_FORM_MAX_BYTES = 30;
const LONG_FORM = 31;
const CLASS_SHIFT = 12;
const ID_SHIFT = 5;
/**
 * The most octets a parameter list holds here. The standard lets a longer list continue in partitions (the length word's bit 15), but the
 * office suite's reader takes that bit as part of the length and draws garbage, so no element is partitioned: a long run of points is
 * several elements (`cgmMaxPoints`) and a large picture several cell arrays.
 */
export const CGM_MAX_PARAMETER_BYTES = 0x7ffe;
/** A string of up to 254 octets has a one-octet count; the writers cut a longer name there. */
const STRING_MAX_BYTES = 254;
const INT16_MAX = 0x7fff;
const INT16_MIN = -0x8000;
export const POINT_BYTES = 4;

/** One element: the command header, the parameter list and the pad octet that makes the whole an even number of octets. */
export function cgmElement(elementClass: number, id: number, parameters: Buffer = Buffer.alloc(0)): Buffer {
  if (parameters.length > CGM_MAX_PARAMETER_BYTES) {
    throw new CadGeometryUnavailableError(`A CGM element of ${parameters.length} octets is longer than the ${CGM_MAX_PARAMETER_BYTES} its length word holds without partitions.`);
  }
  const header = (elementClass << CLASS_SHIFT) | (id << ID_SHIFT);
  const long = parameters.length > SHORT_FORM_MAX_BYTES;
  const lengthBytes = long ? 2 : 0;
  const out = Buffer.alloc(2 + lengthBytes + parameters.length + (parameters.length % 2));
  out.writeUInt16BE(header | (long ? LONG_FORM : parameters.length), 0);
  if (long) out.writeUInt16BE(parameters.length, 2);
  parameters.copy(out, 2 + lengthBytes);
  return out;
}

/** Signed 16-bit integers, the integer and VDC precision the writers declare. */
export function cgmIntegers(...values: number[]): Buffer {
  const out = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => out.writeInt16BE(cgmInt16(value), i * 2));
  return out;
}

/** An integer that fits the 16-bit precision, or the typed refusal for a coordinate that does not. */
export function cgmInt16(value: number, what = 'Coordinate'): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded < INT16_MIN || rounded > INT16_MAX) {
    throw new CadGeometryUnavailableError(`${what} ${rounded} does not fit the 16-bit metafile range.`);
  }
  return rounded;
}

/** A string parameter: the octet count, then the characters (ASCII; any other character is a question mark). */
export function cgmString(text: string): Buffer {
  const characters = Buffer.from(text.replace(/[^\x20-\x7e]/g, '?'), 'latin1').subarray(0, STRING_MAX_BYTES);
  return Buffer.concat([Buffer.from([characters.length]), characters]);
}

/** A direct colour of 8-bit components. */
export function cgmColour(colour: { r: number; g: number; b: number }): Buffer {
  return Buffer.from([colour.r, colour.g, colour.b]);
}

/** Points as pairs of signed 16-bit VDC integers. */
export function cgmPoints(points: readonly { x: number; y: number }[]): Buffer {
  const out = Buffer.alloc(points.length * POINT_BYTES);
  points.forEach((point, i) => {
    out.writeInt16BE(cgmInt16(point.x), i * POINT_BYTES);
    out.writeInt16BE(cgmInt16(point.y), i * POINT_BYTES + 2);
  });
  return out;
}

/** The edge-out flag that ends a ring of a polygon set closed, its edge visible (ISO 8632-1 clause 8.6.8), and the one of every other vertex, its edge visible. */
const EDGE_VISIBLE = 1;
const EDGE_CLOSE_VISIBLE = 3;
export const POLYGON_SET_VERTEX_BYTES = POINT_BYTES + 2;

/** The most points of a polyline or polygon, and vertices of a polygon set, that fit one element. */
export const CGM_MAX_POINTS = Math.floor(CGM_MAX_PARAMETER_BYTES / POINT_BYTES);
export const CGM_MAX_POLYGON_SET_VERTICES = Math.floor(CGM_MAX_PARAMETER_BYTES / POLYGON_SET_VERTEX_BYTES);

/** The vertices of a polygon set: each ring is a run of points with a flag, the last of which closes it. */
export function cgmPolygonSetPoints(rings: readonly (readonly { x: number; y: number }[])[]): Buffer {
  const out = Buffer.alloc(rings.reduce((sum, ring) => sum + ring.length, 0) * POLYGON_SET_VERTEX_BYTES);
  let at = 0;
  for (const ring of rings) {
    ring.forEach((point, i) => {
      out.writeInt16BE(cgmInt16(point.x), at);
      out.writeInt16BE(cgmInt16(point.y), at + 2);
      out.writeInt16BE(i === ring.length - 1 ? EDGE_CLOSE_VISIBLE : EDGE_VISIBLE, at + 4);
      at += POLYGON_SET_VERTEX_BYTES;
    });
  }
  return out;
}
