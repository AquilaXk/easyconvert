import { PdfUnicodeTextWriter, preferredUnicodeFontPath } from '../pdf-fonts';

const WIN_ANSI_SPECIAL_CODES = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

/**
 * Detects whether text contains characters unencodable in standard WinAnsi encoding.
 */
export function isNonWinAnsi(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_SPECIAL_CODES.has(code)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Sanitizes unencodable non-WinAnsi code points gracefully.
 */
export function sanitizeWinAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0xa0 && code <= 0xff) ||
      WIN_ANSI_SPECIAL_CODES.has(code)
    ) {
      out += text[i];
    }
  }
  return out;
}

/** Documents whose text is drawn with an embedded Unicode font (an installed one was found). */
const unicodeFontDocuments = new WeakSet<PDFKit.PDFDocument>();

/** One Unicode text writer per pdfkit document, so each embedded font is registered once. */
const unicodeTextWriters = new WeakMap<PDFKit.PDFDocument, PdfUnicodeTextWriter>();

function unicodeTextWriterFor(doc: PDFKit.PDFDocument, customPath?: string): PdfUnicodeTextWriter {
  let writer = unicodeTextWriters.get(doc);
  if (!writer) {
    writer = new PdfUnicodeTextWriter(doc, customPath);
    unicodeTextWriters.set(doc, writer);
  }
  return writer;
}

/**
 * Resolves the preferred installed Unicode font, or the custom font when it exists.
 */
export function resolveUnicodeFallbackFont(customPath?: string): string | null {
  return preferredUnicodeFontPath(customPath);
}

/**
 * Selects the preferred installed Unicode font in the document. Text drawn through
 * renderSafePdfText then picks, per run, an embedded font that covers its characters.
 */
export function configurePdfKitFontFallback(
  doc: PDFKit.PDFDocument,
  customPath?: string
): { hasUnicodeFont: boolean; fontName?: string } {
  const fontName = unicodeTextWriterFor(doc, customPath).usePrimaryFace();
  if (!fontName) return { hasUnicodeFont: false };
  unicodeFontDocuments.add(doc);
  return { hasUnicodeFont: true, fontName };
}

/**
 * Writes text into a PDFKit document with embedded fonts chosen per run by glyph coverage.
 * Throws EngineUnavailableError when no installed font covers a character, instead of drawing
 * empty boxes. Without any installed Unicode font, WinAnsi-only text keeps the standard font.
 */
export function renderSafePdfText(
  doc: PDFKit.PDFDocument,
  text: string,
  hasUnicodeFont: boolean,
  options?: PDFKit.Mixins.TextOptions,
  x?: number,
  y?: number
): PDFKit.PDFDocument {
  const stringText = String(text ?? '');
  if (!stringText) return doc;

  if (!hasUnicodeFont && !isNonWinAnsi(stringText)) {
    if (x !== undefined && y !== undefined) {
      return doc.text(stringText, x, y, options);
    }
    return doc.text(stringText, options);
  }

  unicodeTextWriterFor(doc).write(stringText, options ?? {}, x, y);
  return doc;
}

/**
 * Height the text takes at the given options, measured with the fonts that renderSafePdfText draws it
 * with: each run in its own embedded font, never the font that happens to be selected in the document.
 */
export function measurePdfTextHeight(doc: PDFKit.PDFDocument, text: string, options: PDFKit.Mixins.TextOptions): number {
  if (!text) return 0;
  if (!unicodeFontDocuments.has(doc) && !isNonWinAnsi(text)) {
    return doc.heightOfString(text, options);
  }
  return unicodeTextWriterFor(doc).heightOf(text, options);
}
