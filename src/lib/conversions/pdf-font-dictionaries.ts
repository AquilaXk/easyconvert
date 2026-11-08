/** What a text reader needs of the font dictionaries a PDF defines, as `PdfDocument` reads them. */

/** A Type0 font dictionary (section 9.7.6) as the file defines it, with what a text reader needs of its descendant CIDFont. */
export interface CompositeFontDictionary {
  objectNumber: number;
  generation: number;
  /** The text of the dictionary (`<< ... >>`) as the file, or the object stream that holds it, writes it. */
  text: string;
  hasToUnicode: boolean;
  /** The /Encoding name (Identity-H or a predefined CMap), or null for an embedded CMap stream. */
  encoding: string | null;
  /** /Subtype of the descendant CIDFont (CIDFontType0 or CIDFontType2). */
  descendant: string | null;
  /** /BaseFont of the descendant CIDFont as written, a subset tag included. */
  descendantName: string | null;
  /** The program the font descriptor embeds: a /FontFile2, a /FontFile3 of subtype CIDFontType0C, or null for none or another. */
  program: 'truetype' | 'cid-cff' | null;
  /** /Registry and /Ordering of the descendant's /CIDSystemInfo, as written (a hex string keeps its digits). */
  registry: string | null;
  ordering: string | null;
  /** The descendant's /CIDToGIDMap: `identity` when absent or /Identity, the decoded stream, or null when unreadable. */
  cidToGidMap(): 'identity' | Buffer | null;
  /** The decoded /FontFile2 of the descendant's font descriptor, or null when there is none or it cannot be decoded. */
  trueTypeProgram(): Buffer | null;
  /** The decoded /FontFile3 of subtype CIDFontType0C of the descendant's font descriptor, or null when there is none or it cannot be decoded. */
  cffProgram(): Buffer | null;
  /** The decoded /ToUnicode stream, or null when the font has none, names a predefined CMap instead, or the stream cannot be decoded. */
  toUnicodeData(): Buffer | null;
  /** The widths the descendant's /W gives the CIDs from `first` to `last` (section 9.7.4.3), read as pdfjs reads them and on the step budget of the call that gave the font; none once it is spent. */
  cidWidths(first: number, last: number): Map<number, number>;
}

/** A simple font dictionary (section 9.6: Type1, MMType1, TrueType or Type3) as the file defines it, with its encoding differences. */
export interface SimpleFontDictionary {
  objectNumber: number;
  generation: number;
  /** The text of the dictionary (`<< ... >>`) as the file, or the object stream that holds it, writes it. */
  text: string;
  hasToUnicode: boolean;
  /** /BaseFont as written, a subset tag included. */
  baseFont: string | null;
  /** The items of the /Differences array of an /Encoding dictionary (section 9.6.5.1): integer codes and glyph names, null for any other item; null when there is no array. */
  differences: ReadonlyArray<number | string | null> | null;
}
