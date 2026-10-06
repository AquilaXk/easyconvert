import { deflateSync } from 'node:zlib';
import { PDFContext, PDFDict, PDFName, PDFRawStream } from 'pdf-lib';
import { ConversionFailedError } from '../types';

/**
 * CID bookkeeping and ToUnicode CMap serialization for the OCR text-layer font.
 *
 * The font is a Type 0 / Identity-H composite font, so every character code is a 2-byte CID.
 * Each distinct code point used by the document receives its own dense CID (1, 2, 3, ...; CID 0
 * stays .notdef) and the ToUnicode CMap maps each CID to UTF-16BE with `bfchar` entries. A
 * `bfrange` cannot express this because ISO 32000-1 §9.10.3 only lets the last byte of a code
 * vary inside a range, and astral code points need a surrogate pair as destination.
 */

/** CIDs are 2 bytes wide under the `<0000> <FFFF>` code space. */
export const MAX_TEXT_LAYER_CID = 0xffff;
/** The CMap specification limits one `beginbfchar` block to 100 entries. */
export const TO_UNICODE_BFCHAR_BLOCK_LIMIT = 100;
/** Glyph advance (1/1000 em) advertised for code points above U+00FF (CJK, Hangul, kana). */
/** Glyph space units per em in the text layer font. */
export const GLYPH_UNITS_PER_EM = 1000;
export const WIDE_GLYPH_ADVANCE = GLYPH_UNITS_PER_EM;
/** Glyph advance (1/1000 em) advertised for Latin-1 code points. */
export const NARROW_GLYPH_ADVANCE = 500;
const NARROW_GLYPH_MAX_CODE_POINT = 0xff;
const MAX_UNICODE_CODE_POINT = 0x10ffff;
const BMP_MAX_CODE_POINT = 0xffff;
const HIGH_SURROGATE_MIN = 0xd800;
const LOW_SURROGATE_MIN = 0xdc00;
const SURROGATE_MAX = 0xdfff;
const ASTRAL_OFFSET = 0x10000;
const SURROGATE_PAYLOAD_BITS = 0x400;
const HEX_RADIX = 16;
const HEX_DIGITS_PER_UNIT = 4;

function isUnicodeScalarValue(cp: number): boolean {
  return (
    Number.isInteger(cp) &&
    cp >= 0 &&
    cp <= MAX_UNICODE_CODE_POINT &&
    !(cp >= HIGH_SURROGATE_MIN && cp <= SURROGATE_MAX)
  );
}

function hex16(unit: number): string {
  return unit.toString(HEX_RADIX).padStart(HEX_DIGITS_PER_UNIT, '0').toUpperCase();
}

/** Serializes one code point as UTF-16BE hex (4 digits for the BMP, 8 for a surrogate pair). */
export function codePointToUtf16BeHex(cp: number): string {
  if (!isUnicodeScalarValue(cp)) {
    throw new ConversionFailedError(`Text layer code point U+${cp.toString(HEX_RADIX)} is not a Unicode scalar value`);
  }
  if (cp <= BMP_MAX_CODE_POINT) {
    return hex16(cp);
  }
  const offset = cp - ASTRAL_OFFSET;
  const high = Math.floor(offset / SURROGATE_PAYLOAD_BITS) + HIGH_SURROGATE_MIN;
  const low = (offset % SURROGATE_PAYLOAD_BITS) + LOW_SURROGATE_MIN;
  return hex16(high) + hex16(low);
}

const COMBINING_MARK = /\p{M}/u;

/** Advance for a code point: combining marks take no space, Latin-1 half an em, the rest a full em. */
export function glyphAdvanceForCodePoint(cp: number): number {
  if (COMBINING_MARK.test(String.fromCodePoint(cp))) return 0;
  return cp <= NARROW_GLYPH_MAX_CODE_POINT ? NARROW_GLYPH_ADVANCE : WIDE_GLYPH_ADVANCE;
}

/**
 * Serializes a CID to code point table as a ToUnicode CMap. Each CID is a 2-byte source code and
 * each destination is UTF-16BE. Entries are emitted in blocks of at most
 * TO_UNICODE_BFCHAR_BLOCK_LIMIT `bfchar` mappings.
 */
export function buildToUnicodeCMapFromCids(entries: ReadonlyArray<readonly [number, number]>): string {
  const seen = new Set<number>();
  const lines: string[] = [];
  for (const [cid, cp] of entries) {
    if (!Number.isInteger(cid) || cid < 0 || cid > MAX_TEXT_LAYER_CID) {
      throw new ConversionFailedError(`Text layer CID ${String(cid)} is outside the 2-byte code space`);
    }
    if (seen.has(cid)) {
      throw new ConversionFailedError(`Text layer CID ${cid} is mapped more than once`);
    }
    seen.add(cid);
    lines.push(`<${hex16(cid)}> <${codePointToUtf16BeHex(cp)}>`);
  }

  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += TO_UNICODE_BFCHAR_BLOCK_LIMIT) {
    const chunk = lines.slice(i, i + TO_UNICODE_BFCHAR_BLOCK_LIMIT);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }

  const body = blocks.length > 0 ? `${blocks.join('\n')}\n` : '';
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/**
 * Allocates dense CIDs to the distinct code points of the text layer, in first-use order.
 */
export class TextLayerCidMap {
  private readonly cidByCodePoint = new Map<number, number>();
  private readonly codePoints: number[] = [];

  constructor(private readonly onAssign?: (cid: number, codePoint: number) => void) {}

  get size(): number {
    return this.codePoints.length;
  }

  /** CID to code point pairs in ascending CID order. */
  entries(): Array<[number, number]> {
    return this.codePoints.map((cp, index): [number, number] => [index + 1, cp]);
  }

  cidFor(codePoint: number): number {
    const existing = this.cidByCodePoint.get(codePoint);
    if (existing !== undefined) {
      return existing;
    }
    if (!isUnicodeScalarValue(codePoint)) {
      throw new ConversionFailedError(
        `Text layer contains an unpaired surrogate or invalid code point (0x${codePoint.toString(HEX_RADIX)})`
      );
    }
    const cid = this.codePoints.length + 1;
    if (cid > MAX_TEXT_LAYER_CID) {
      throw new ConversionFailedError(
        `Text layer uses more than ${MAX_TEXT_LAYER_CID} distinct characters, exceeding the 2-byte CID space`
      );
    }
    this.codePoints.push(codePoint);
    this.cidByCodePoint.set(codePoint, cid);
    this.onAssign?.(cid, codePoint);
    return cid;
  }

  /**
   * Encodes text as Identity-H hex, four digits per code point. The text is not normalized: the
   * layer carries exactly the code points OCR recognized (NFC would rewrite compatibility
   * ideographs such as U+F900 and letterlike symbols such as U+2126).
   */
  encodeText(text: string): string {
    let hex = '';
    for (const char of text) {
      hex += hex16(this.cidFor(char.codePointAt(0) as number));
    }
    return hex;
  }
}

/**
 * ToUnicode stream whose content is generated from the CID map when the document is serialized,
 * so CIDs allocated after the font object was created are still covered.
 */
// pdf-lib marks the PDFRawStream constructor private in its typings; the class itself is extensible.
const ExtensibleRawStream = PDFRawStream as unknown as new (dict: PDFDict, contents: Uint8Array) => PDFRawStream;

export class LazyToUnicodeStream extends ExtensibleRawStream {
  private cachedSize = -1;
  private cachedBytes: Uint8Array = new Uint8Array(0);

  constructor(
    dict: PDFDict,
    private readonly cids: TextLayerCidMap
  ) {
    super(dict, new Uint8Array(0));
    dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    // pdf-lib's stream decoder reads `contents` directly, so serve the generated bytes there too.
    Object.defineProperty(this, 'contents', { get: () => this.render(), set: () => undefined, configurable: true });
  }

  private render(): Uint8Array {
    if (this.cachedSize !== this.cids.size) {
      const cmap = buildToUnicodeCMapFromCids(this.cids.entries());
      this.cachedBytes = new Uint8Array(deflateSync(Buffer.from(cmap, 'latin1')));
      this.cachedSize = this.cids.size;
    }
    return this.cachedBytes;
  }

  override asUint8Array(): Uint8Array {
    return this.render().slice();
  }

  override getContents(): Uint8Array {
    return this.render();
  }

  override getContentsSize(): number {
    return this.render().length;
  }

  override getContentsString(): string {
    return Buffer.from(this.render()).toString('latin1');
  }

  /** A snapshot for another document (pdf-lib's object copier passes the destination context). */
  override clone(context?: PDFContext): PDFRawStream {
    return PDFRawStream.of(this.dict.clone(context ?? this.dict.context), this.render().slice());
  }
}
