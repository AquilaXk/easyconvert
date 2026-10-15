/**
 * Builds small ICC profiles for tests, written from ICC.1:2022 (sections 7 and 10). Matrix/TRC profiles carry
 * colorants and curves given by the caller (published values, not derived by the code under test); a LUT-only
 * profile has an A2B0 tag and no matrix.
 */

export type Xyz = readonly [number, number, number];

export type CurveSpec =
  | { readonly type: 'identity' }
  | { readonly type: 'gamma'; readonly gamma: number }
  | { readonly type: 'table'; readonly values: readonly number[] }
  | { readonly type: 'para'; readonly fn: 0 | 1 | 2 | 3 | 4; readonly params: readonly number[] };

export interface MatrixProfileSpec {
  readonly version: 2 | 4;
  readonly red: Xyz;
  readonly green: Xyz;
  readonly blue: Xyz;
  readonly curves: readonly [CurveSpec, CurveSpec, CurveSpec];
}

/** Colorants (D50 adapted) of the sRGB profile published by the ICC. */
export const SRGB_COLORANTS = {
  red: [0.43607, 0.22249, 0.01392] as Xyz,
  green: [0.38515, 0.71687, 0.09708] as Xyz,
  blue: [0.14307, 0.06061, 0.7141] as Xyz,
};

/** Colorants (D50 adapted) of the Display P3 profile. */
export const DISPLAY_P3_COLORANTS = {
  red: [0.51512, 0.2412, -0.00105] as Xyz,
  green: [0.29198, 0.69225, 0.04189] as Xyz,
  blue: [0.1571, 0.06657, 0.78407] as Xyz,
};

/** The sRGB parametric curve (IEC 61966-2-1) as ICC parametric function type 3. */
export const SRGB_PARA: CurveSpec = { type: 'para', fn: 3, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };

const HEADER_BYTES = 128;
const D50: Xyz = [0.9642, 1, 0.8249];
const S15_FIXED16 = 65_536;

function s15(value: number): number {
  return Math.round(value * S15_FIXED16);
}

function pad4(buf: Buffer): Buffer {
  const padded = Buffer.alloc(Math.ceil(buf.length / 4) * 4);
  buf.copy(padded);
  return padded;
}

function xyzTag(xyz: Xyz): Buffer {
  const out = Buffer.alloc(20);
  out.write('XYZ ', 0, 'latin1');
  xyz.forEach((value, i) => out.writeInt32BE(s15(value), 8 + i * 4));
  return out;
}

function curveTag(spec: CurveSpec): Buffer {
  if (spec.type === 'identity') {
    const out = Buffer.alloc(12);
    out.write('curv', 0, 'latin1');
    return out;
  }
  if (spec.type === 'gamma') {
    const out = Buffer.alloc(14);
    out.write('curv', 0, 'latin1');
    out.writeUInt32BE(1, 8);
    out.writeUInt16BE(Math.round(spec.gamma * 256), 12);
    return out;
  }
  if (spec.type === 'table') {
    const out = Buffer.alloc(12 + spec.values.length * 2);
    out.write('curv', 0, 'latin1');
    out.writeUInt32BE(spec.values.length, 8);
    spec.values.forEach((value, i) => out.writeUInt16BE(Math.round(value * 65_535), 12 + i * 2));
    return out;
  }
  const out = Buffer.alloc(12 + spec.params.length * 4);
  out.write('para', 0, 'latin1');
  out.writeUInt16BE(spec.fn, 8);
  spec.params.forEach((value, i) => out.writeInt32BE(s15(value), 12 + i * 4));
  return out;
}

function textTag(version: 2 | 4, text: string): Buffer {
  if (version === 4) {
    const utf16 = Buffer.from(text, 'utf16le').swap16();
    const out = Buffer.alloc(28 + utf16.length);
    out.write('mluc', 0, 'latin1');
    out.writeUInt32BE(1, 8);
    out.writeUInt32BE(12, 12);
    out.write('enUS', 16, 'latin1');
    out.writeUInt32BE(utf16.length, 20);
    out.writeUInt32BE(28, 24);
    utf16.copy(out, 28);
    return out;
  }
  const ascii = Buffer.from(`${text}\0`, 'latin1');
  const out = Buffer.alloc(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
  out.write('desc', 0, 'latin1');
  out.writeUInt32BE(ascii.length, 8);
  ascii.copy(out, 12);
  return out;
}

function assemble(version: 2 | 4, colourSpace: string, tags: Array<[string, Buffer]>): Buffer {
  const table = Buffer.alloc(4 + tags.length * 12);
  table.writeUInt32BE(tags.length, 0);
  let offset = HEADER_BYTES + table.length;
  const bodies: Buffer[] = [];
  tags.forEach(([signature, data], i) => {
    const padded = pad4(data);
    table.write(signature, 4 + i * 12, 'latin1');
    table.writeUInt32BE(offset, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
    bodies.push(padded);
    offset += padded.length;
  });
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(offset, 0);
  header.write('test', 4, 'latin1');
  header.writeUInt32BE(version === 4 ? 0x04200000 : 0x02400000, 8);
  header.write('mntr', 12, 'latin1');
  header.write(colourSpace, 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  header.writeUInt16BE(2024, 24);
  header.writeUInt16BE(1, 26);
  header.writeUInt16BE(1, 28);
  header.write('acsp', 36, 'latin1');
  header.write('APPL', 40, 'latin1');
  D50.forEach((value, i) => header.writeInt32BE(s15(value), 68 + i * 4));
  return Buffer.concat([header, table, ...bodies]);
}

export function buildMatrixProfile(spec: MatrixProfileSpec): Buffer {
  const tags: Array<[string, Buffer]> = [
    ['desc', textTag(spec.version, 'test matrix profile')],
    ['cprt', spec.version === 4 ? textTag(4, 'none') : Buffer.from('text\0\0\0\0none\0', 'latin1')],
    ['wtpt', xyzTag(D50)],
    ['rXYZ', xyzTag(spec.red)],
    ['gXYZ', xyzTag(spec.green)],
    ['bXYZ', xyzTag(spec.blue)],
    ['rTRC', curveTag(spec.curves[0])],
    ['gTRC', curveTag(spec.curves[1])],
    ['bTRC', curveTag(spec.curves[2])],
  ];
  return assemble(spec.version, 'RGB ', tags);
}

/** A well-formed RGB profile whose colour transform is a lookup table (A2B0), without matrix tags. */
export function buildLutOnlyProfile(): Buffer {
  const lut = Buffer.alloc(32);
  lut.write('mft1', 0, 'latin1');
  return assemble(4, 'RGB ', [
    ['desc', textTag(4, 'lut profile')],
    ['wtpt', xyzTag(D50)],
    ['A2B0', lut],
  ]);
}

/** A grey profile (`GRAY`, kTRC). */
export function buildGrayProfile(): Buffer {
  return assemble(4, 'GRAY', [
    ['desc', textTag(4, 'grey profile')],
    ['wtpt', xyzTag(D50)],
    ['kTRC', curveTag({ type: 'gamma', gamma: 2.2 })],
  ]);
}
