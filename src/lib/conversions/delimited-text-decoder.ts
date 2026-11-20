import { DataEncodingError, UnsupportedOptionError } from '../types';
import { assertDataInputBytes, assertDataItemCount } from './data-limits';
import { LEGACY_TABLES, MIN_LEGACY_EVIDENCE_CHARS, decodeWithTable } from './legacy-tables';

/** Decoding of delimited text (CSV / TSV / TAB) and of the other data sources that name their own encoding, shared by the data engine and the sheet writers of the office engine. */

type ByteRange = readonly [first: number, last: number];

/** Byte-order marks that identify a Unicode encoding outright; a BOM wins over any label (WHATWG "decode"). */
const BOM_SIGNATURES: readonly { bytes: readonly number[]; encoding: string }[] = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
];

/** Leading bytes inspected for the NUL pattern of BOM-less UTF-16 text. */
const UTF16_SNIFF_BYTES = 4096;
/** Share of code units whose high byte must be NUL: ASCII-range UTF-16 text has one in every unit. */
const UTF16_NUL_LANE_MIN_SHARE = 0.5;
/** Share of code units whose other byte may be NUL before the NUL pattern stops looking like UTF-16. */
const UTF16_OTHER_LANE_MAX_SHARE = 0.05;
const ASCII_LIMIT = 0x80;

/** One block of a double-byte code space: a lead byte range by its trail byte ranges. */
interface DoubleByteBlock {
  leads: ByteRange;
  trails: readonly ByteRange[];
}

interface LegacyEncodingCandidate {
  /** WHATWG encoding name, a key of LEGACY_TABLES. */
  encoding: string;
  /**
   * iconv-lite table used for detection. Big5 is detected with plain CP950: Big5-HKSCS maps
   * user-defined pairs onto ordinary characters, which would make byte soup look like Big5.
   * Big5 text that needs HKSCS characters is decoded with the explicit "big5" encoding option.
   */
  table: string;
  /** The encoding's standard character set, without vendor extensions or user-defined rows. */
  standard: readonly DoubleByteBlock[];
  /** The part of the standard set that everyday text mostly uses; it breaks ties on `standard`. */
  core: readonly DoubleByteBlock[];
}

const KS_X_1001_TRAILS: readonly ByteRange[] = [[0xa1, 0xfe]];
const SHIFT_JIS_TRAILS: readonly ByteRange[] = [[0x40, 0x7e], [0x80, 0xfc]];
const GB_2312_TRAILS: readonly ByteRange[] = [[0xa1, 0xfe]];
const BIG5_TRAILS: readonly ByteRange[] = [[0x40, 0x7e], [0xa1, 0xfe]];

/**
 * Legacy CJK encodings tried, in tie-break order, when the input is neither BOM-marked, UTF-16
 * nor valid UTF-8. Each of them decodes most byte soup without error, so a candidate is dropped
 * when its reading holds private-use characters (user-defined rows real text does not use) and is
 * otherwise scored by the share of its non-ASCII characters inside the encoding's standard set
 * (KS X 1001 symbols, Hangul and Hanja; JIS X 0208; GB 2312; Big5 levels 1 and 2), then by the
 * share inside its everyday core (KS X 1001 symbols and the 2,350 Hangul syllables; JIS X 0208
 * symbols, kana and level-1 kanji; GB 2312 symbols and level-1 hanzi; Big5 symbols and level 1).
 * Korean Hangul also reads as GB 2312 level-1 hanzi with equal scores, so EUC-KR comes first;
 * Chinese reads as a Hangul/Hanja mix whose core share is lower than GB 2312's.
 */
const LEGACY_ENCODING_CANDIDATES: readonly LegacyEncodingCandidate[] = [
  {
    encoding: 'euc-kr',
    table: 'cp949',
    standard: [
      { leads: [0xa1, 0xac], trails: KS_X_1001_TRAILS },
      { leads: [0xb0, 0xc8], trails: KS_X_1001_TRAILS },
      { leads: [0xca, 0xfd], trails: KS_X_1001_TRAILS },
    ],
    core: [
      { leads: [0xa1, 0xac], trails: KS_X_1001_TRAILS },
      { leads: [0xb0, 0xc8], trails: KS_X_1001_TRAILS },
    ],
  },
  {
    encoding: 'shift_jis',
    table: 'cp932',
    standard: [
      { leads: [0x81, 0x84], trails: SHIFT_JIS_TRAILS },
      { leads: [0x88, 0x9f], trails: SHIFT_JIS_TRAILS },
      { leads: [0xe0, 0xea], trails: SHIFT_JIS_TRAILS },
    ],
    core: [{ leads: [0x81, 0x98], trails: SHIFT_JIS_TRAILS }],
  },
  {
    encoding: 'gbk',
    table: 'gb18030',
    standard: [
      { leads: [0xa1, 0xa9], trails: GB_2312_TRAILS },
      { leads: [0xb0, 0xf7], trails: GB_2312_TRAILS },
    ],
    core: [
      { leads: [0xa1, 0xa9], trails: GB_2312_TRAILS },
      { leads: [0xb0, 0xd7], trails: GB_2312_TRAILS },
    ],
  },
  {
    encoding: 'big5',
    table: 'cp950',
    standard: [
      { leads: [0xa1, 0xc6], trails: BIG5_TRAILS },
      { leads: [0xc9, 0xf9], trails: BIG5_TRAILS },
    ],
    core: [{ leads: [0xa1, 0xc6], trails: BIG5_TRAILS }],
  },
];

/** iconv-lite table of the single-byte encoding tried when no CJK candidate qualifies (Windows-1252). */
const SINGLE_BYTE_FALLBACK_TABLE = 'cp1252';
/** C0 controls other than tab, LF and CR: not text. */
const SINGLE_BYTE_CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;
/** Private-use characters: a legacy reading that needs user-defined rows is not real text. */
const PRIVATE_USE = /[-]/;
/** Minimum share of non-ASCII characters that must fall in a candidate's standard set. */
const LEGACY_REPERTOIRE_MIN_SHARE = 0.5;
const DETECTED_ENCODINGS_LABEL = 'UTF-8, UTF-16, EUC-KR/CP949, Shift_JIS, GBK, Big5 and Windows-1252';

const legacyRepertoireCache = new Map<readonly DoubleByteBlock[], ReadonlySet<number>>();

/** Code points of a set of double-byte blocks, decoded once per block list. */
function legacyRepertoire(table: string, blocks: readonly DoubleByteBlock[]): ReadonlySet<number> {
  const cached = legacyRepertoireCache.get(blocks);
  if (cached) return cached;
  const repertoire = new Set<number>();
  const pair = new Uint8Array(2);
  for (const { leads, trails } of blocks) {
    for (let lead = leads[0]; lead <= leads[1]; lead++) {
      for (const [trailFirst, trailLast] of trails) {
        for (let trail = trailFirst; trail <= trailLast; trail++) {
          pair[0] = lead;
          pair[1] = trail;
          const decoded = decodeWithTable(pair, table);
          const codePoint = decoded?.codePointAt(0);
          if (
            decoded &&
            codePoint !== undefined &&
            codePoint >= ASCII_LIMIT &&
            !PRIVATE_USE.test(decoded) &&
            decoded.length === String.fromCodePoint(codePoint).length
          ) {
            repertoire.add(codePoint);
          }
        }
      }
    }
  }
  legacyRepertoireCache.set(blocks, repertoire);
  return repertoire;
}

interface LegacyGuess {
  text: string;
  nonAscii: number;
  standardShare: number;
  coreShare: number;
}

function scoreLegacyCandidate(bytes: Uint8Array, candidate: LegacyEncodingCandidate): LegacyGuess | null {
  const text = decodeWithTable(bytes, candidate.table);
  if (text === null || PRIVATE_USE.test(text)) return null;
  const standard = legacyRepertoire(candidate.table, candidate.standard);
  const core = legacyRepertoire(candidate.table, candidate.core);
  let nonAscii = 0;
  let inStandard = 0;
  let inCore = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < ASCII_LIMIT) continue;
    const codePoint = code >= 0xd800 && code <= 0xdbff ? (text.codePointAt(i++) ?? code) : code;
    nonAscii++;
    if (standard.has(codePoint)) inStandard++;
    if (core.has(codePoint)) inCore++;
  }
  if (nonAscii === 0) return null;
  return { text, nonAscii, standardShare: inStandard / nonAscii, coreShare: inCore / nonAscii };
}

function decodeSingleByteFallback(bytes: Uint8Array): LegacyGuess | null {
  const text = decodeWithTable(bytes, SINGLE_BYTE_FALLBACK_TABLE);
  if (text === null || SINGLE_BYTE_CONTROL.test(text)) return null;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= ASCII_LIMIT) {
      if (code >= 0xd800 && code <= 0xdbff) i++;
      nonAscii++;
    }
  }
  return { text, nonAscii, standardShare: 1, coreShare: 1 };
}

export function sniffBom(bytes: Uint8Array): string | null {
  for (const { bytes: signature, encoding } of BOM_SIGNATURES) {
    if (bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte)) {
      return encoding;
    }
  }
  return null;
}

/** BOM-less UTF-16 from its NUL lane: Latin-script text puts a zero byte in every code unit. */
export function sniffUtf16ByNulPattern(bytes: Uint8Array): string | null {
  const units = Math.floor(Math.min(bytes.length, UTF16_SNIFF_BYTES) / 2);
  if (units === 0) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let unit = 0; unit < units; unit++) {
    if (bytes[unit * 2] === 0) evenNul++;
    if (bytes[unit * 2 + 1] === 0) oddNul++;
  }
  const nulLaneMin = units * UTF16_NUL_LANE_MIN_SHARE;
  const otherLaneMax = units * UTF16_OTHER_LANE_MAX_SHARE;
  if (oddNul >= nulLaneMin && evenNul <= otherLaneMax) return 'utf-16le';
  if (evenNul >= nulLaneMin && oddNul <= otherLaneMax) return 'utf-16be';
  return null;
}

/** Decodes with a canonical WHATWG encoding name; invalid input throws instead of yielding U+FFFD. */
export function decodeStrict(bytes: Uint8Array, encoding: string): string {
  const table = LEGACY_TABLES.get(encoding);
  if (table !== undefined) {
    const text = decodeWithTable(bytes, table);
    if (text === null) throw new DataEncodingError(`Input is not valid ${encoding} text.`);
    return text;
  }
  try {
    // ignoreBOM stays false, so a BOM of this encoding is stripped.
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new DataEncodingError(`Input is not valid ${encoding} text.`);
  }
}

export function canonicalEncoding(label: string): string {
  try {
    return new TextDecoder(label).encoding;
  } catch {
    throw new UnsupportedOptionError(`Option "encoding" must be a WHATWG encoding label; "${label}" is not one.`);
  }
}

/**
 * The best-scoring legacy reading of bytes that are not UTF-8: CJK candidates first (a strictly
 * higher standard share wins, then a strictly higher core share, then candidate order), then
 * Windows-1252. A guess backed by fewer than MIN_LEGACY_EVIDENCE_CHARS non-ASCII characters is
 * refused: the caller must name the encoding.
 */
function detectLegacyText(bytes: Uint8Array): string {
  let best: LegacyGuess | null = null;
  for (const candidate of LEGACY_ENCODING_CANDIDATES) {
    const guess = scoreLegacyCandidate(bytes, candidate);
    if (!guess || guess.standardShare < LEGACY_REPERTOIRE_MIN_SHARE) continue;
    const better =
      !best ||
      guess.standardShare > best.standardShare ||
      (guess.standardShare === best.standardShare && guess.coreShare > best.coreShare);
    if (better) {
      best = guess;
      if (best.standardShare === 1 && best.coreShare === 1) break;
    }
  }
  const guess = best ?? decodeSingleByteFallback(bytes);
  if (!guess) {
    throw new DataEncodingError(
      `Could not detect the text encoding (tried ${DETECTED_ENCODINGS_LABEL}); pass the "encoding" option.`
    );
  }
  if (guess.nonAscii < MIN_LEGACY_EVIDENCE_CHARS) {
    throw new DataEncodingError(
      `Too little non-ASCII text (${guess.nonAscii} characters, at least ${MIN_LEGACY_EVIDENCE_CHARS} needed) to detect the text encoding; pass the "encoding" option.`
    );
  }
  return guess.text;
}

/**
 * Decodes delimited-text bytes: a BOM decides first, then an explicit `encoding` option, then the
 * NUL pattern of BOM-less UTF-16, then strict UTF-8 (TextDecoder, fatal), then the scored legacy
 * candidates. Every decode is strict, so undecodable bytes raise a DataEncodingError instead
 * of turning into U+FFFD.
 */
export function decodeDelimitedText(bytes: Uint8Array, requestedEncoding?: string): string {
  const bomEncoding = sniffBom(bytes);
  if (bomEncoding) return decodeStrict(bytes, bomEncoding);
  if (requestedEncoding !== undefined) return decodeStrict(bytes, canonicalEncoding(requestedEncoding));
  const utf16 = sniffUtf16ByNulPattern(bytes);
  if (utf16) return decodeStrict(bytes, utf16);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not UTF-8: fall through to the legacy candidates.
  }
  return detectLegacyText(bytes);
}

/**
 * `decodeDelimitedText` of a source held to the size and the count of cells and records of `DATA_SOURCE_LIMITS.delimited`: the size is
 * checked before the bytes are decoded and the count before the text is parsed, so a hostile text is refused (413) before any cell exists.
 */
export function decodeCheckedDelimitedText(bytes: Uint8Array, requestedEncoding: string | undefined, label: string): string {
  assertDataInputBytes('delimited', bytes.length, label);
  const text = decodeDelimitedText(bytes, requestedEncoding);
  assertDataItemCount('delimited', text, label);
  return text;
}
