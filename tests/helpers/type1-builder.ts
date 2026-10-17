/**
 * Independent writer for PostScript Type 1 fonts (PFA and PFB), authored from Adobe's "Adobe Type 1 Font Format" (the eexec and charstring
 * encryption of chapter 7, the Type 1 charstring commands of chapter 6, the PFB segments of Adobe Technical Note 5040) with no dependency on
 * src/. It builds the small fonts the tests need: any number of glyphs drawn with straight and curved segments, with the line endings,
 * the container and the segmentation chosen by the caller.
 */

const EEXEC_KEY = 55665;
const CHARSTRING_KEY = 4330;
const CIPHER_C1 = 52845;
const CIPHER_C2 = 22719;
/** The four bytes that start every encrypted run; they decrypt to anything. */
const LEADING_BYTES = Buffer.from([0x41, 0x42, 0x43, 0x44]);
const HEX_LINE_CHARACTERS = 64;
const TRAILER_ZEROS = 512;

function encrypt(plain: Buffer, key: number): Buffer {
  const out = Buffer.alloc(plain.length);
  let r = key;
  plain.forEach((byte, index) => {
    const cipher = byte ^ (r >> 8);
    out[index] = cipher;
    r = ((cipher + r) * CIPHER_C1 + CIPHER_C2) & 0xffff;
  });
  return out;
}

const COMMANDS = { hsbw: 13, closepath: 9, rlineto: 5, rrcurveto: 8, rmoveto: 21, endchar: 14, return: 11 } as const;
/** Subroutines every font carries (the standard four plus one), each only a `return`: a private dictionary with Subrs is what real fonts have. */
const SUBR_COUNT = 5;

/** A Type 1 charstring number: one byte for -107..107, two for -1131..1131, five otherwise. */
function number(value: number): number[] {
  if (value >= -107 && value <= 107) return [value + 139];
  if (value >= 108 && value <= 1131) {
    const v = value - 108;
    return [(v >> 8) + 247, v & 0xff];
  }
  if (value >= -1131 && value <= -108) {
    const v = -value - 108;
    return [(v >> 8) + 251, v & 0xff];
  }
  return [255, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

type Step = { kind: 'move'; dx: number; dy: number } | { kind: 'line'; dx: number; dy: number } | { kind: 'curve'; d: [number, number, number, number, number, number] };

function charstring(width: number, steps: Step[]): Buffer {
  const bytes: number[] = [...number(0), ...number(width), COMMANDS.hsbw];
  let open = false;
  for (const step of steps) {
    if (step.kind === 'move') {
      if (open) bytes.push(COMMANDS.closepath);
      bytes.push(...number(step.dx), ...number(step.dy), COMMANDS.rmoveto);
      open = true;
    } else if (step.kind === 'line') {
      bytes.push(...number(step.dx), ...number(step.dy), COMMANDS.rlineto);
    } else {
      for (const value of step.d) bytes.push(...number(value));
      bytes.push(COMMANDS.rrcurveto);
    }
  }
  if (open) bytes.push(COMMANDS.closepath);
  bytes.push(COMMANDS.endchar);
  return Buffer.from(bytes);
}

export interface Type1Glyph {
  name: string;
  /** Advance width in em units of 1000. */
  width: number;
  /** Path steps relative to the previous point; the glyph is empty when there are none. */
  steps: Step[];
}

/** A glyph drawn as one rectangle from (left, 0) with the given size. */
export function rectangleGlyph(name: string, width: number, left: number, w: number, h: number): Type1Glyph {
  return {
    name,
    width,
    steps: [
      { kind: 'move', dx: left, dy: 0 },
      { kind: 'line', dx: w, dy: 0 },
      { kind: 'line', dx: 0, dy: h },
      { kind: 'line', dx: -w, dy: 0 },
    ],
  };
}

/** A glyph drawn as a circle of the given radius sitting on the baseline over the middle of its advance, from four cubic arcs (handle length 0.5523 of the radius). */
export function circleGlyph(name: string, width: number, radius: number): Type1Glyph {
  const k = Math.round(radius * 0.5523);
  const r = radius;
  return {
    name,
    width,
    steps: [
      { kind: 'move', dx: Math.round(width / 2) + r, dy: r },
      { kind: 'curve', d: [0, k, k - r, r - k, -k, 0] },
      { kind: 'curve', d: [-k, 0, k - r, k - r, 0, -k] },
      { kind: 'curve', d: [0, -k, r - k, k - r, k, 0] },
      { kind: 'curve', d: [k, 0, r - k, r - k, 0, k] },
    ],
  };
}

/** The glyph's charstring as it is stored in the font: encrypted under the charstring key, after four leading bytes. */
export function charstringCipher(glyph: Type1Glyph): Buffer {
  return encrypt(Buffer.concat([LEADING_BYTES, charstring(glyph.width, glyph.steps)]), CHARSTRING_KEY);
}

export interface Type1Options {
  fontName?: string;
  familyName?: string;
  /** Line ending of the text of the file: the clear text and the private dictionary. */
  lineEnding?: '\n' | '\r' | '\r\n';
  /** Split the encrypted part of a PFB into segments of this many bytes. */
  binarySegmentBytes?: number;
  /** First line of the file, up to the font name: `%!FontType1-1.0` (the default) or `%!PS-AdobeFont-1.0`. */
  signature?: '%!FontType1-1.0' | '%!PS-AdobeFont-1.0';
  /** How the private dictionary names its read and define procedures: `RD ND NP` (with `executeonly`) or the `-| |- |` spelling. */
  procedures?: 'words' | 'symbols';
}

const PROCEDURES = {
  words: { read: 'RD', define: 'ND', put: 'NP', definitions: ['/RD {string currentfile exch readstring pop} executeonly def', '/ND {noaccess def} executeonly def', '/NP {noaccess put} executeonly def'] },
  symbols: { read: '-|', define: '|-', put: '|', definitions: ['/-| {string currentfile exch readstring pop} def', '/|- {def} def', '/| {put} def'] },
} as const;

/**
 * The private dictionary in the layout of its two common families: with `words` (RD ND NP) the Adobe layout, one `2 index /CharStrings`
 * line and a closing `readonly put noaccess put`; with `symbols` (-| |- |) the layout the fontTools test fonts use, which writes the
 * `/CharStrings` header across two lines and closes the dictionaries with `end put`.
 */
function privateDictionary(glyphs: Type1Glyph[], eol: string, procedures: keyof typeof PROCEDURES): Buffer {
  const parts: Buffer[] = [];
  const names = PROCEDURES[procedures];
  const symbols = procedures === 'symbols';
  const text = (value: string) => parts.push(Buffer.from(value.split('\n').join(eol), 'latin1'));
  text([symbols ? 'dup /Private\n8 dict dup begin' : 'dup /Private 8 dict dup begin', ...names.definitions, '/BlueValues [] def', '/MinFeature {16 16} def', '/password 5839 def', `/Subrs ${SUBR_COUNT} array`, ''].join('\n'));
  for (let index = 0; index < SUBR_COUNT; index++) {
    const subr = encrypt(Buffer.concat([LEADING_BYTES, Buffer.from([COMMANDS.return])]), CHARSTRING_KEY);
    text(`dup ${index} ${subr.length} ${names.read} `);
    parts.push(subr);
    text(` ${names.put}\n`);
  }
  text(symbols ? `def\nput\ndup /CharStrings\n${glyphs.length} dict dup begin\n` : `ND\n2 index /CharStrings ${glyphs.length} dict dup begin\n`);
  for (const glyph of glyphs) {
    const program = charstringCipher(glyph);
    text(`/${glyph.name} ${program.length} ${names.read} `);
    parts.push(program);
    text(` ${names.define}\n`);
  }
  text(symbols ? 'end put\nend\n' : 'end\nend\nreadonly put\nnoaccess put\n');
  text('dup /FontName get exch definefont pop\nmark\ncurrentfile closefile\n');
  return Buffer.concat(parts);
}

function clearText(options: Required<Pick<Type1Options, 'fontName' | 'familyName' | 'lineEnding' | 'signature'>>, afterEexec: string): Buffer {
  const text = [
    `${options.signature}: ${options.fontName} 1.0`,
    '11 dict begin',
    '/FontInfo 4 dict dup begin',
    '/version (1.0) readonly def',
    `/FullName (${options.familyName} Regular) readonly def`,
    `/FamilyName (${options.familyName}) readonly def`,
    '/Weight (Regular) readonly def',
    'end readonly def',
    `/FontName /${options.fontName} def`,
    '/PaintType 0 def',
    '/FontType 1 def',
    '/FontMatrix [0.001 0 0 0.001 0 0] readonly def',
    '/Encoding StandardEncoding def',
    '/FontBBox {0 0 1000 1000} readonly def',
    'currentdict end',
    'currentfile eexec',
  ].join('\n');
  return Buffer.from(text.split('\n').join(options.lineEnding) + afterEexec, 'latin1');
}

function trailer(eol: string): Buffer {
  const zeros = ('0'.repeat(64) + eol).repeat(TRAILER_ZEROS / 64);
  return Buffer.from(`${zeros}cleartomark${eol}`, 'latin1');
}

/** The encrypted run of a font: four leading bytes and the private dictionary, under the eexec key. */
function encryptedRun(glyphs: Type1Glyph[], eol: string, procedures: keyof typeof PROCEDURES): Buffer {
  return encrypt(Buffer.concat([LEADING_BYTES, privateDictionary(glyphs, eol, procedures)]), EEXEC_KEY);
}

function withDefaults(options: Type1Options) {
  return {
    fontName: options.fontName ?? 'BuiltT1-Regular',
    familyName: options.familyName ?? 'Built T1',
    lineEnding: options.lineEnding ?? '\n',
    procedures: options.procedures ?? 'symbols',
    signature: options.signature ?? '%!FontType1-1.0',
    binarySegmentBytes: options.binarySegmentBytes,
  };
}

/** A PFA file: the clear text, the encrypted run as hexadecimal lines, and the zeros and cleartomark. */
export function buildPfa(glyphs: Type1Glyph[], options: Type1Options = {}): Buffer {
  const { lineEnding, procedures, fontName, familyName, signature } = withDefaults(options);
  const hex = encryptedRun(glyphs, lineEnding, procedures).toString('hex');
  const lines = hex.match(new RegExp(`.{1,${HEX_LINE_CHARACTERS}}`, 'g')) ?? [];
  return Buffer.concat([clearText({ fontName, familyName, lineEnding, signature }, ' '), Buffer.from(lines.join(lineEnding) + lineEnding, 'latin1'), trailer(lineEnding)]);
}

function segment(type: 1 | 2, body: Buffer): Buffer {
  const header = Buffer.alloc(6);
  header[0] = 0x80;
  header[1] = type;
  header.writeUInt32LE(body.length, 2);
  return Buffer.concat([header, body]);
}

/** A PFB file: an ASCII segment, the encrypted run as binary segments, an ASCII trailer segment and the end marker. */
export function buildPfb(glyphs: Type1Glyph[], options: Type1Options = {}): Buffer {
  const { lineEnding, binarySegmentBytes, procedures, fontName, familyName, signature } = withDefaults(options);
  const run = encryptedRun(glyphs, lineEnding, procedures);
  const size = binarySegmentBytes ?? run.length;
  const binary: Buffer[] = [];
  for (let at = 0; at < run.length; at += size) binary.push(segment(2, run.subarray(at, at + size)));
  return Buffer.concat([segment(1, clearText({ fontName, familyName, lineEnding, signature }, lineEnding)), ...binary, segment(1, trailer(lineEnding)), Buffer.from([0x80, 3])]);
}

/** A PFA whose encrypted run decrypts to noise: a real header and a run of the right shape, and no private dictionary inside. */
export function pfaWithGarbageRun(): Buffer {
  const garbage = Buffer.from(Array.from({ length: 96 }, (_, index) => (index * 37 + 11) & 0xff));
  return Buffer.concat([clearText({ fontName: 'Hollow', familyName: 'Hollow', lineEnding: '\n', signature: '%!FontType1-1.0' }, ' '), Buffer.from(garbage.toString('hex') + '\n'), trailer('\n')]);
}

/** A PFA header and clear text with no `eexec` section after it. */
export function pfaWithoutPrivateDictionary(): Buffer {
  return Buffer.from('%!FontType1-1.0: Bare 1.0\n/FontName /Bare def\n/FontType 1 def\n', 'latin1');
}
