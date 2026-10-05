/**
 * Independent Adobe Type 1 font writer for tests.
 *
 * Written directly from the Adobe Type 1 Font Format specification ("black book"): its own
 * charstring encoder, its own eexec and charstring encryption, and its own PFB / PFA framing.
 * It imports nothing from src, so the engine under test never produces its own input.
 *
 * The OtherSubrs bodies are placeholders: the spec fixes the meaning of OtherSubrs entries 0 to 3
 * for rasterisers, so readers implement them natively and never run the PostScript text.
 */

// ---------------------------------------------------------------------------------------------
// Charstring encoder (spec chapter 6)
// ---------------------------------------------------------------------------------------------

const OPERATORS: Readonly<Record<string, readonly number[]>> = {
  hstem: [1],
  vstem: [3],
  vmoveto: [4],
  rlineto: [5],
  hlineto: [6],
  vlineto: [7],
  rrcurveto: [8],
  closepath: [9],
  callsubr: [10],
  return: [11],
  hsbw: [13],
  endchar: [14],
  rmoveto: [21],
  hmoveto: [22],
  vhcurveto: [30],
  hvcurveto: [31],
  dotsection: [12, 0],
  vstem3: [12, 1],
  hstem3: [12, 2],
  seac: [12, 6],
  sbw: [12, 7],
  div: [12, 12],
  callothersubr: [12, 16],
  pop: [12, 17],
  setcurrentpoint: [12, 33],
};

export type CharToken = number | keyof typeof OPERATORS;

function encodeNumber(value: number): number[] {
  if (!Number.isInteger(value)) throw new Error(`charstring operand ${value} must be an integer`);
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) {
    const v = value - 108;
    return [247 + (v >> 8), v & 0xff];
  }
  if (value >= -1131 && value <= -108) {
    const v = -value - 108;
    return [251 + (v >> 8), v & 0xff];
  }
  const out = Buffer.alloc(5);
  out[0] = 255;
  out.writeInt32BE(value, 1);
  return [...out];
}

export function assembleCharString(tokens: readonly CharToken[]): Buffer {
  const bytes: number[] = [];
  for (const token of tokens) {
    if (typeof token === 'number') {
      bytes.push(...encodeNumber(token));
    } else {
      const op = OPERATORS[token];
      if (!op) throw new Error(`unknown charstring operator ${token}`);
      bytes.push(...op);
    }
  }
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------------------------
// Encryption (spec chapter 7)
// ---------------------------------------------------------------------------------------------

const EEXEC_R = 55665;
const CHARSTRING_R = 4330;
const C1 = 52845;
const C2 = 22719;

function encryptBytes(plain: Buffer, seed: number): Buffer {
  const out = Buffer.alloc(plain.length);
  let r = seed;
  for (let i = 0; i < plain.length; i++) {
    const cipher = plain[i] ^ (r >> 8);
    out[i] = cipher;
    r = ((cipher + r) * C1 + C2) % 65536;
  }
  return out;
}

function sealCharString(plain: Buffer, lenIV: number): Buffer {
  if (lenIV < 0) return plain;
  const lead = Buffer.alloc(lenIV, 0x20);
  return encryptBytes(Buffer.concat([lead, plain]), CHARSTRING_R);
}

// ---------------------------------------------------------------------------------------------
// Expected geometry, written by hand in glyph space (1000 units per em)
// ---------------------------------------------------------------------------------------------

export type ExpectedSegment =
  | { kind: 'L'; x: number; y: number }
  | { kind: 'C'; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number };

export interface ExpectedContour {
  start: [number, number];
  segments: ExpectedSegment[];
}

export interface ExpectedGlyph {
  name: string;
  unicode: number;
  advance: number;
  /** xMin, yMin, xMax, yMax of the outline, derived by hand from the coordinates below. */
  bbox: [number, number, number, number] | null;
  contours: ExpectedContour[];
}

function polygon(points: Array<[number, number]>): ExpectedContour {
  const [first, ...rest] = points;
  return { start: first, segments: rest.map(([x, y]) => ({ kind: 'L', x, y })) };
}

const H_CONTOUR = polygon([
  [80, 0],
  [180, 0],
  [180, 300],
  [520, 300],
  [520, 0],
  [620, 0],
  [620, 700],
  [520, 700],
  [520, 400],
  [180, 400],
  [180, 700],
  [80, 700],
]);

const O_OUTER: ExpectedContour = {
  start: [560, 350],
  segments: [
    { kind: 'C', x1: 560, y1: 549, x2: 444, y2: 710, x3: 300, y3: 710 },
    { kind: 'C', x1: 156, y1: 710, x2: 40, y2: 549, x3: 40, y3: 350 },
    { kind: 'C', x1: 40, y1: 151, x2: 156, y2: -10, x3: 300, y3: -10 },
    { kind: 'C', x1: 444, y1: -10, x2: 560, y2: 151, x3: 560, y3: 350 },
  ],
};

const O_INNER: ExpectedContour = {
  start: [440, 350],
  segments: [
    { kind: 'C', x1: 440, y1: 212, x2: 377, y2: 100, x3: 300, y3: 100 },
    { kind: 'C', x1: 223, y1: 100, x2: 160, y2: 212, x3: 160, y3: 350 },
    { kind: 'C', x1: 160, y1: 488, x2: 223, y2: 600, x3: 300, y3: 600 },
    { kind: 'C', x1: 377, y1: 600, x2: 440, y2: 488, x3: 440, y3: 350 },
  ],
};

const E_CONTOUR: ExpectedContour = {
  start: [50, 0],
  segments: [
    { kind: 'C', x1: 100, y1: 0, x2: 180, y2: -18, x3: 250, y3: -20 },
    { kind: 'C', x1: 320, y1: -18, x2: 400, y2: 0, x3: 450, y3: 0 },
    { kind: 'L', x: 450, y: 600 },
    { kind: 'L', x: 50, y: 600 },
  ],
};

const I_CONTOUR = polygon([
  [100, 0],
  [200, 0],
  [200, 700],
  [100, 700],
]);

const A_CONTOUR = polygon([
  [20, 0],
  [110, 0],
  [160, 180],
  [540, 180],
  [590, 0],
  [680, 0],
  [400, 700],
  [300, 700],
]);

const ACUTE_CONTOUR = polygon([
  [100, 600],
  [180, 600],
  [300, 760],
  [220, 760],
]);

/** The accent sits at (sbx + adx - asb, ady) = (20 + 180 - 100, 30) = (100, 30) in Aacute. */
const AACUTE_ACCENT_CONTOUR = polygon([
  [200, 630],
  [280, 630],
  [400, 790],
  [320, 790],
]);

export const EXPECTED_GLYPHS: Readonly<Record<string, ExpectedGlyph>> = {
  '.notdef': { name: '.notdef', unicode: -1, advance: 500, bbox: null, contours: [] },
  space: { name: 'space', unicode: 0x20, advance: 250, bbox: null, contours: [] },
  H: { name: 'H', unicode: 0x48, advance: 700, bbox: [80, 0, 620, 700], contours: [H_CONTOUR] },
  O: { name: 'O', unicode: 0x4f, advance: 600, bbox: [40, -10, 560, 710], contours: [O_OUTER, O_INNER] },
  E: { name: 'E', unicode: 0x45, advance: 500, bbox: [50, -20, 450, 600], contours: [E_CONTOUR] },
  I: { name: 'I', unicode: 0x49, advance: 300, bbox: [100, 0, 200, 700], contours: [I_CONTOUR] },
  A: { name: 'A', unicode: 0x41, advance: 700, bbox: [20, 0, 680, 700], contours: [A_CONTOUR] },
  acute: { name: 'acute', unicode: 0xb4, advance: 333, bbox: [100, 600, 300, 760], contours: [ACUTE_CONTOUR] },
  Aacute: {
    name: 'Aacute',
    unicode: 0xc1,
    advance: 700,
    bbox: [20, 0, 680, 790],
    contours: [A_CONTOUR, AACUTE_ACCENT_CONTOUR],
  },
};

// ---------------------------------------------------------------------------------------------
// Charstrings for the glyphs above, written with the operators a font editor would emit
// ---------------------------------------------------------------------------------------------

/** Subrs 0 to 3 are the standard flex and hint replacement entries; 4 and 5 are font specific. */
export const STANDARD_SUBRS: readonly (readonly CharToken[])[] = [
  [3, 0, 'callothersubr', 'pop', 'pop', 'setcurrentpoint', 'return'],
  [0, 1, 'callothersubr', 'return'],
  [0, 2, 'callothersubr', 'return'],
  ['return'],
  [0, 20, 'hstem', 700, 20, 'hstem', 'return'],
  [100, 'hlineto', 'return'],
];

const GLYPH_CHARSTRINGS: ReadonlyArray<readonly [string, readonly CharToken[]]> = [
  ['.notdef', [0, 0, 500, 0, 'sbw', 'endchar']],
  ['space', [0, 500, 2, 'div', 'hsbw', 'endchar']],
  [
    'H',
    [
      80, 700, 'hsbw',
      0, 700, 'hstem',
      80, 100, 'vstem',
      0, 0, 'rmoveto',
      5, 'callsubr',
      300, 'vlineto',
      340, 'hlineto',
      -300, 'vlineto',
      100, 'hlineto',
      700, 'vlineto',
      -100, 'hlineto',
      -300, 'vlineto',
      -340, 'hlineto',
      300, 'vlineto',
      -100, 'hlineto',
      'closepath',
      'endchar',
    ],
  ],
  [
    'O',
    [
      40, 600, 'hsbw',
      520, 350, 'rmoveto',
      199, -116, 161, -144, 'vhcurveto',
      -144, -116, -161, -199, 'hvcurveto',
      -199, 116, -161, 144, 'vhcurveto',
      144, 116, 161, 199, 'hvcurveto',
      'closepath',
      -120, 0, 'rmoveto',
      -138, -63, -112, -77, 'vhcurveto',
      -77, -63, 112, 138, 'hvcurveto',
      138, 63, 112, 77, 'vhcurveto',
      77, 63, -112, -138, 'hvcurveto',
      'closepath',
      'endchar',
    ],
  ],
  [
    'E',
    [
      50, 500, 'hsbw',
      0, 0, 'rmoveto',
      1, 'callsubr',
      200, 0, 'rmoveto', 2, 'callsubr',
      -150, 0, 'rmoveto', 2, 'callsubr',
      80, -18, 'rmoveto', 2, 'callsubr',
      70, -2, 'rmoveto', 2, 'callsubr',
      70, 2, 'rmoveto', 2, 'callsubr',
      80, 18, 'rmoveto', 2, 'callsubr',
      50, 0, 'rmoveto', 2, 'callsubr',
      20, 450, 0, 0, 'callsubr',
      600, 'vlineto',
      -400, 'hlineto',
      'closepath',
      'endchar',
    ],
  ],
  [
    'I',
    [
      100, 300, 'hsbw',
      0, 0, 'rmoveto',
      100, 'hlineto',
      4, 1, 3, 'callothersubr', 'pop', 'callsubr',
      700, 'vlineto',
      -100, 'hlineto',
      'closepath',
      'endchar',
    ],
  ],
  [
    'A',
    [
      20, 700, 'hsbw',
      0, 0, 'rmoveto',
      90, 0, 'rlineto',
      50, 180, 'rlineto',
      380, 0, 'rlineto',
      50, -180, 'rlineto',
      90, 0, 'rlineto',
      -280, 700, 'rlineto',
      -100, 0, 'rlineto',
      'closepath',
      'endchar',
    ],
  ],
  [
    'acute',
    [
      100, 333, 'hsbw',
      0, 600, 'rmoveto',
      80, 0, 'rlineto',
      120, 160, 'rlineto',
      -80, 0, 'rlineto',
      'closepath',
      'endchar',
    ],
  ],
  ['Aacute', [20, 700, 'hsbw', 100, 180, 30, 65, 194, 'seac']],
];

const ENCODING_ASSIGNMENTS: ReadonlyArray<readonly [number, string]> = [
  [32, 'space'],
  [65, 'A'],
  [69, 'E'],
  [72, 'H'],
  [73, 'I'],
  [79, 'O'],
  [193, 'Aacute'],
  [194, 'acute'],
];

// ---------------------------------------------------------------------------------------------
// Font assembly
// ---------------------------------------------------------------------------------------------

export interface Type1BuilderOptions {
  fontName?: string;
  familyName?: string;
  fullName?: string;
  weight?: string;
  italicAngle?: number;
  /** Charstring lead bytes; -1 leaves charstrings unencrypted. Defaults to 4. */
  lenIV?: number;
  /** Replaces the charstring of a named glyph (adds the glyph when absent). */
  charStrings?: Readonly<Record<string, readonly CharToken[]>>;
  /** Replaces the whole Subrs list. */
  subrs?: readonly (readonly CharToken[])[];
  /** Overrides the number printed after /Subrs while the entries stay as written. */
  declaredSubrCount?: number;
  /** Writes the /Encoding as `StandardEncoding def` instead of a custom array. */
  standardEncoding?: boolean;
  /** Replaces the custom /Encoding assignments (code, glyph name). */
  encoding?: ReadonlyArray<readonly [number, string]>;
  /** Overrides the number printed after /CharStrings while the entries stay as written. */
  declaredGlyphCount?: number;
}

export interface BuiltType1Font {
  pfb: Buffer;
  pfa: Buffer;
  fontName: string;
  familyName: string;
  weight: string;
  expectedGlyphs: ExpectedGlyph[];
}

const DEFAULT_FONT_NAME = 'EasyConvertT1Test';
const DEFAULT_FAMILY_NAME = 'EasyConvert T1 Test';
const EEXEC_PLAINTEXT_LEAD = Buffer.from('QAZX', 'latin1');
const PFA_HEX_LINE = 64;
const PFA_TRAILER_ZERO_LINES = 8;

function pfbSegment(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0x80;
  header[1] = type;
  header.writeUInt32LE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

interface CleartextOptions {
  fontName: string;
  familyName: string;
  fullName: string;
  weight: string;
  italicAngle: number;
  standardEncoding: boolean;
  encoding: ReadonlyArray<readonly [number, string]>;
}

function buildCleartext(opts: CleartextOptions): string {
  const lines = [
    `%!PS-AdobeFont-1.0: ${opts.fontName} 001.000`,
    '%%Title: easyconvert type 1 test font',
    '11 dict begin',
    '/FontInfo 9 dict dup begin',
    '/version (001.000) readonly def',
    '/Notice (Test font written from the Type 1 specification.) readonly def',
    `/FullName (${opts.fullName}) readonly def`,
    `/FamilyName (${opts.familyName}) readonly def`,
    `/Weight (${opts.weight}) readonly def`,
    `/ItalicAngle ${opts.italicAngle} def`,
    '/isFixedPitch false def',
    '/UnderlinePosition -100 def',
    '/UnderlineThickness 50 def',
    'end readonly def',
    `/FontName /${opts.fontName} def`,
    '/PaintType 0 def',
    '/FontType 1 def',
    '/FontMatrix [0.001 0 0 0.001 0 0] readonly def',
  ];
  if (opts.standardEncoding) {
    lines.push('/Encoding StandardEncoding def');
  } else {
    lines.push('/Encoding 256 array', '0 1 255 {1 index exch /.notdef put} for');
    for (const [code, name] of opts.encoding) lines.push(`dup ${code} /${name} put`);
    lines.push('readonly def');
  }
  lines.push('/FontBBox {20 -20 680 790} readonly def', 'currentdict end', 'currentfile eexec', '');
  return lines.join('\n');
}

function buildPrivatePortion(opts: Type1BuilderOptions): Buffer {
  const lenIV = opts.lenIV ?? 4;
  const subrDefs = opts.subrs ?? STANDARD_SUBRS;
  const glyphs = new Map<string, readonly CharToken[]>(GLYPH_CHARSTRINGS);
  for (const [name, tokens] of Object.entries(opts.charStrings ?? {})) glyphs.set(name, tokens);

  const parts: Buffer[] = [];
  const text = (s: string): void => {
    parts.push(Buffer.from(s, 'latin1'));
  };
  const lenIVLine = lenIV === 4 ? '' : `/lenIV ${lenIV} def\n`;
  text(
    [
      'dup /Private 14 dict dup begin',
      '/RD {string currentfile exch readstring pop} executeonly def',
      '/ND {noaccess def} executeonly def',
      '/NP {noaccess put} executeonly def',
      '/BlueValues [-15 0 700 715] def',
      '/MinFeature {16 16} def',
      '/password 5839 def',
      '/OtherSubrs [ {} {} {}',
      '{ systemdict /internaldict known not { pop 3 } { 1183615869 systemdict /internaldict get exec',
      '(Hint) pop 3 } ifelse } executeonly ] def',
      `${lenIVLine}/Subrs ${opts.declaredSubrCount ?? subrDefs.length} array`,
      '',
    ].join('\n')
  );
  subrDefs.forEach((tokens, index) => {
    const sealed = sealCharString(assembleCharString(tokens), lenIV);
    text(`dup ${index} ${sealed.length} RD `);
    parts.push(sealed);
    text(' NP\n');
  });
  text(`ND\n2 index /CharStrings ${opts.declaredGlyphCount ?? glyphs.size} dict dup begin\n`);
  for (const [name, tokens] of glyphs) {
    const sealed = sealCharString(assembleCharString(tokens), lenIV);
    text(`/${name} ${sealed.length} RD `);
    parts.push(sealed);
    text(' ND\n');
  }
  text('end\nend\nreadonly put\nnoaccess put\ndup /FontName get exch definefont pop\nmark currentfile closefile\n');
  return Buffer.concat(parts);
}

export function buildType1Font(options: Type1BuilderOptions = {}): BuiltType1Font {
  const fontName = options.fontName ?? DEFAULT_FONT_NAME;
  const familyName = options.familyName ?? DEFAULT_FAMILY_NAME;
  const weight = options.weight ?? 'Regular';
  const fullName = options.fullName ?? `${familyName} ${weight}`;
  const italicAngle = options.italicAngle ?? 0;

  const cleartext = Buffer.from(
    buildCleartext({
      fontName,
      familyName,
      fullName,
      weight,
      italicAngle,
      standardEncoding: options.standardEncoding ?? false,
      encoding: options.encoding ?? ENCODING_ASSIGNMENTS,
    }),
    'latin1'
  );
  const plain = Buffer.concat([EEXEC_PLAINTEXT_LEAD, buildPrivatePortion(options)]);
  const encrypted = encryptBytes(plain, EEXEC_R);
  if (encrypted[0] === 0x20 || encrypted[0] === 0x0a || encrypted[0] === 0x0d || encrypted[0] === 0x09) {
    throw new Error('first eexec ciphertext byte must not be whitespace');
  }

  const zeros = Array.from({ length: PFA_TRAILER_ZERO_LINES }, () => '0'.repeat(PFA_HEX_LINE)).join('\n');
  const trailer = Buffer.from(`\n${zeros}\ncleartomark\n`, 'latin1');

  const pfb = Buffer.concat([
    pfbSegment(1, cleartext),
    pfbSegment(2, encrypted),
    pfbSegment(1, trailer),
    Buffer.from([0x80, 0x03]),
  ]);

  const hex = encrypted.toString('hex');
  const hexLines: string[] = [];
  for (let i = 0; i < hex.length; i += PFA_HEX_LINE) hexLines.push(hex.slice(i, i + PFA_HEX_LINE));
  const pfa = Buffer.concat([cleartext, Buffer.from(hexLines.join('\n'), 'latin1'), trailer]);

  const names = ['.notdef', 'space', 'H', 'O', 'E', 'I', 'A', 'acute', 'Aacute'];
  return { pfb, pfa, fontName, familyName, weight, expectedGlyphs: names.map((n) => EXPECTED_GLYPHS[n]) };
}
