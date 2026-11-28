import { expect } from 'vitest';

/**
 * An independent reader of the binary encoding of a Computer Graphics Metafile (ISO/IEC 8632-3), written from the standard's element tables and
 * layouts and sharing nothing with the writer (`src/lib/conversions/cgm-binary.ts`). It walks the elements strictly (a header of a 4-bit class, a 7-bit
 * id and a 5-bit parameter length, a length word behind 31, parameters padded to an even number of octets, no partition, the file ending with an
 * element) and decodes the elements the writers produce, so a test can state what a file holds as values and not as bytes.
 */

export interface BinaryCgmElement {
  elementClass: number;
  id: number;
  parameters: Buffer;
}

const SHORT_FORM_MAX = 30;
const LONG_FORM = 31;
const PARTITION_BIT = 0x8000;

/** The elements of a binary CGM, in file order; fails a file that is cut, padded wrongly or partitioned. */
export function cgmBinaryElements(cgm: Buffer): BinaryCgmElement[] {
  const elements: BinaryCgmElement[] = [];
  let at = 0;
  while (at < cgm.length) {
    expect(at + 2, 'a command header is cut').toBeLessThanOrEqual(cgm.length);
    const header = cgm.readUInt16BE(at);
    at += 2;
    let length = header & 0x1f;
    if (length === LONG_FORM) {
      length = cgm.readUInt16BE(at);
      at += 2;
      expect(length & PARTITION_BIT, 'the writers write no partitioned element').toBe(0);
      expect(length, 'a long form of a list that fits the short one').toBeGreaterThan(SHORT_FORM_MAX);
    }
    expect(at + length + (length % 2), 'a parameter list is cut').toBeLessThanOrEqual(cgm.length);
    elements.push({ elementClass: header >> 12, id: (header >> 5) & 0x7f, parameters: cgm.subarray(at, at + length) });
    if (length % 2) expect(cgm[at + length], 'the pad octet is zero').toBe(0);
    at += length + (length % 2);
  }
  return elements;
}

export const CGM_BINARY_NAMES: Readonly<Record<string, string>> = {
  '0.1': 'BEGMF', '0.2': 'ENDMF', '0.3': 'BEGPIC', '0.4': 'BEGPICBODY', '0.5': 'ENDPIC',
  '1.1': 'MFVERSION', '1.2': 'MFDESC', '1.3': 'VDCTYPE', '1.4': 'INTEGERPREC', '1.7': 'COLRPREC', '1.10': 'COLRVALUEEXT', '1.11': 'MFELEMLIST',
  '2.2': 'COLRMODE', '2.3': 'LINEWIDTHMODE', '2.6': 'VDCEXT', '2.7': 'BACKCOLR',
  '3.1': 'VDCINTEGERPREC',
  '4.1': 'POLYLINE', '4.7': 'POLYGON', '4.8': 'POLYGONSET', '4.9': 'CELLARRAY',
  '5.3': 'LINEWIDTH', '5.4': 'LINECOLR', '5.22': 'INTSTYLE', '5.23': 'FILLCOLR', '5.37': 'LINECAP', '5.38': 'LINEJOIN',
};

export function cgmBinaryName(element: BinaryCgmElement): string {
  const name = CGM_BINARY_NAMES[`${element.elementClass}.${element.id}`];
  expect(name, `element class ${element.elementClass} id ${element.id} is one the writers produce`).toBeDefined();
  return name;
}

/** A string parameter: a one-octet count, then the characters. */
export function cgmBinaryString(parameters: Buffer): string {
  const count = parameters[0];
  expect(count, 'a string of up to 254 octets').toBeLessThan(255);
  expect(parameters.length, 'a string fills its parameter list').toBe(1 + count);
  return parameters.toString('latin1', 1, 1 + count);
}

/** Pairs of signed 16-bit VDC integers. */
export function cgmBinaryPoints(parameters: Buffer): { x: number; y: number }[] {
  expect(parameters.length % 4).toBe(0);
  const points: { x: number; y: number }[] = [];
  for (let at = 0; at < parameters.length; at += 4) points.push({ x: parameters.readInt16BE(at), y: parameters.readInt16BE(at + 2) });
  return points;
}

/** The rings of a polygon set: a vertex is a point and an edge-out flag, and a flag of 2 or 3 closes the ring (ISO/IEC 8632-1 clause 8.6.8). */
export function cgmBinaryPolygonSet(parameters: Buffer): { x: number; y: number }[][] {
  expect(parameters.length % 6).toBe(0);
  const rings: { x: number; y: number }[][] = [];
  let ring: { x: number; y: number }[] = [];
  for (let at = 0; at < parameters.length; at += 6) {
    ring.push({ x: parameters.readInt16BE(at), y: parameters.readInt16BE(at + 2) });
    const flag = parameters.readInt16BE(at + 4);
    expect(flag).toBeGreaterThanOrEqual(0);
    expect(flag).toBeLessThanOrEqual(3);
    if (flag >= 2) {
      rings.push(ring);
      ring = [];
    }
  }
  expect(ring, 'a polygon set ends with a closing flag').toEqual([]);
  return rings;
}

/** A direct colour of three 8-bit components. */
export function cgmBinaryColour(parameters: Buffer): [number, number, number] {
  expect(parameters.length).toBe(3);
  return [parameters[0], parameters[1], parameters[2]];
}

export interface BinaryCellArray {
  p: { x: number; y: number };
  q: { x: number; y: number };
  r: { x: number; y: number };
  columns: number;
  rows: number;
  precision: number;
  mode: number;
  /** The cells row by row, each as `[red, green, blue]`. */
  cells: [number, number, number][][];
}

const DIRECT_24_BITS = 24;
const PACKED_LIST = 1;

/** A cell array of direct colour in packed list mode: three points, the counts, the local colour precision, the mode, then rows that each end on a word boundary. */
export function cgmBinaryCellArray(parameters: Buffer): BinaryCellArray {
  const [p, q, r] = cgmBinaryPoints(parameters.subarray(0, 12));
  const [columns, rows, precision, mode] = [12, 14, 16, 18].map((at) => parameters.readInt16BE(at));
  expect(precision, 'direct colour cells of 24 bits').toBe(DIRECT_24_BITS);
  expect(mode, 'packed list mode').toBe(PACKED_LIST);
  const rowBytes = columns * 3 + ((columns * 3) % 2);
  expect(parameters.length, 'the cells fill the parameter list').toBe(20 + rowBytes * rows);
  const cells: [number, number, number][][] = [];
  for (let row = 0; row < rows; row++) {
    const cellRow: [number, number, number][] = [];
    for (let column = 0; column < columns; column++) {
      const at = 20 + row * rowBytes + column * 3;
      cellRow.push([parameters[at], parameters[at + 1], parameters[at + 2]]);
    }
    cells.push(cellRow);
  }
  return { p, q, r, columns, rows, precision, mode, cells };
}

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  COLRMODE: ['INDEXED', 'DIRECT'],
  LINEWIDTHMODE: ['ABS', 'SCALED'],
  VDCTYPE: ['INTEGER', 'REAL'],
  INTSTYLE: ['HOLLOW', 'SOLID', 'PATTERN', 'HATCH', 'EMPTY'],
};
const EDGE_FLAGS = ['INVIS', 'VIS', 'CLOSEINVIS', 'CLOSEVIS'];

function quoted(text: string): string {
  return `"${text.split('"').join('""')}"`;
}

function pointText(point: { x: number; y: number }): string {
  return `(${point.x},${point.y})`;
}

function integers(parameters: Buffer): number[] {
  expect(parameters.length % 2).toBe(0);
  return Array.from({ length: parameters.length / 2 }, (_, i) => parameters.readInt16BE(i * 2));
}

/** One element in the spelling of ISO/IEC 8632-4, so that a test that states a file as clear text can read a binary one. */
function clearText(element: BinaryCgmElement): string {
  const name = cgmBinaryName(element);
  const { parameters } = element;
  if (name === 'BEGMF' || name === 'BEGPIC' || name === 'MFDESC') return `${name} ${quoted(cgmBinaryString(parameters))};`;
  if (name in ENUMS) return `${name} ${ENUMS[name][integers(parameters)[0]]};`;
  if (name === 'VDCEXT') return `${name} ${cgmBinaryPoints(parameters).map(pointText).join(' ')};`;
  if (name === 'POLYLINE' || name === 'POLYGON') return `${name} ${cgmBinaryPoints(parameters).map(pointText).join(' ')};`;
  if (name === 'POLYGONSET') {
    const vertices = cgmBinaryPolygonSet(parameters).flatMap((ring) => ring.map((point, i) => `${pointText(point)} ${EDGE_FLAGS[i === ring.length - 1 ? 3 : 1]}`));
    return `${name} ${vertices.join(' ')};`;
  }
  if (name === 'LINECOLR' || name === 'FILLCOLR' || name === 'BACKCOLR') return `${name} ${cgmBinaryColour(parameters).join(' ')};`;
  if (name === 'COLRVALUEEXT') return `${name} ${Array.from(parameters).join(' ')};`;
  if (name === 'CELLARRAY') {
    const cellArray = cgmBinaryCellArray(parameters);
    return `${name} ${pointText(cellArray.p)} ${pointText(cellArray.q)} ${pointText(cellArray.r)} ${cellArray.columns} ${cellArray.rows};`;
  }
  return parameters.length === 0 ? `${name};` : `${name} ${integers(parameters).join(' ')};`;
}

/** A binary CGM as clear text, element by element. */
export function cgmBinaryAsClearText(cgm: Buffer): string {
  return `${cgmBinaryElements(cgm).map(clearText).join('\n')}\n`;
}
