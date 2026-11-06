import { safeDecodeXmlEntities, safeExtractXmlElements, type SafeXmlElement } from '../safe-xml-scanner';
import { SYMBOL_FONT_FIRST_CODE, SYMBOL_FONT_LAST_CODE, SYMBOL_FONT_PRIVATE_USE_BASE } from '../symbol-font-map';
import { reportConversionWarning } from '../conversion-warnings';
import { SymbolReplacements } from './symbol-replacements';

/**
 * Symbol-font characters in the runs of a PresentationML slide. PowerPoint stores a character of Symbol, Wingdings and the
 * like at U+F000 + its code in the font, with the font in the `a:sym` typeface of the run ([ECMA-376] 21.1.2.3.12). The
 * office suite sets the symbol typeface on exactly the characters of U+F000 to U+F0FF and leaves the others in the run's
 * own typeface (`oox/source/drawingml/textrun.cxx`, `TextRun::insertAt`, the loop over `bSymbol`); a run with no symbol
 * typeface keeps its Latin one, as the reader of PowerPoint 97-2003 files does. Here the characters are rewritten in the
 * XML of the slide, so that every reader of the slide (text, tables, grouped shapes, the drawing of the page) sees the
 * character the glyph depicts.
 */

const MAX_UNLIMITED = Number.POSITIVE_INFINITY;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const FIRST_SYMBOL_CODE = SYMBOL_FONT_PRIVATE_USE_BASE + SYMBOL_FONT_FIRST_CODE;
const LAST_SYMBOL_CODE = SYMBOL_FONT_PRIVATE_USE_BASE + SYMBOL_FONT_LAST_CODE;
const END_TEXT_TAG = '</a:t>';
const END_RUN_TAG = '</a:r>';

/** A symbol-font character as itself, as a hexadecimal reference or as a decimal one (a quick filter: the code is checked after). */
const SYMBOL_CHARACTER_OR_REFERENCE = /[-]|&#[xX]([0-9a-fA-F]+);|&#(\d+);/g;
/** A slide that holds none of the three spellings needs no scan of its runs. */
const HAS_SYMBOL_CANDIDATE = /[-]|&#[xX]0*[fF]0[0-9a-fA-F]{2};|&#0*61[4-6]\d\d;/;

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function firstElement(xml: string, tag: string): SafeXmlElement | undefined {
  return safeExtractXmlElements(xml, tag, { maxElements: 1 })[0];
}

/** The typeface the symbol characters of a run take: its symbol typeface, else its Latin one, else its complex-script one. */
function symbolTypeface(runContent: string): string | undefined {
  const properties = firstElement(runContent, 'a:rPr');
  if (properties === undefined) return undefined;
  for (const tag of ['a:sym', 'a:latin', 'a:cs']) {
    const typeface = firstElement(properties.content, tag)?.attrs.typeface;
    if (typeface !== undefined && typeface !== '') return safeDecodeXmlEntities(typeface);
  }
  return undefined;
}

/** The code point a match stands for: the character itself, or the number of its hexadecimal or decimal reference. */
function codeOf(match: string, hex: string | undefined, decimal: string | undefined): number {
  if (hex !== undefined) return Number.parseInt(hex, HEX_RADIX);
  if (decimal !== undefined) return Number.parseInt(decimal, DECIMAL_RADIX);
  return match.charCodeAt(0);
}

function rewriteTextContent(content: string, font: string | undefined, symbols: SymbolReplacements): string {
  return content.replace(SYMBOL_CHARACTER_OR_REFERENCE, (match, hex: string | undefined, decimal: string | undefined) => {
    const code = codeOf(match, hex, decimal);
    return code >= FIRST_SYMBOL_CODE && code <= LAST_SYMBOL_CODE ? escapeText(symbols.character(font, code)) : match;
  });
}

function rewriteRun(run: string, symbols: SymbolReplacements): string {
  const content = run.slice(run.indexOf('>') + 1, run.length - END_RUN_TAG.length);
  const font = symbolTypeface(content);
  const parts: string[] = [];
  let from = 0;
  for (const text of safeExtractXmlElements(content, 'a:t', { maxElements: MAX_UNLIMITED })) {
    if (!text.raw.endsWith(END_TEXT_TAG)) continue;
    const bodyStart = text.endIndex - END_TEXT_TAG.length - text.content.length;
    parts.push(content.slice(from, bodyStart), rewriteTextContent(text.content, font, symbols));
    from = text.endIndex - END_TEXT_TAG.length;
  }
  parts.push(content.slice(from));
  return run.slice(0, run.indexOf('>') + 1) + parts.join('') + END_RUN_TAG;
}

/** The symbol-font characters of the slides of one presentation: the slide XML is rewritten slide by slide, and the replacements are reported once at the end. */
export class PptxSymbolRuns {
  private readonly symbols: SymbolReplacements;

  /** `canDraw`: what the output can draw (see `SymbolReplacements`); absent when it has no limit. */
  constructor(canDraw?: (character: string) => boolean) {
    this.symbols = new SymbolReplacements(canDraw);
  }

  /** The slide XML with each symbol-font character of its runs replaced by the character its font draws (or U+FFFD, reported by `report`). */
  map(xml: string): string {
    if (!HAS_SYMBOL_CANDIDATE.test(xml)) return xml;
    const parts: string[] = [];
    let from = 0;
    for (const run of safeExtractXmlElements(xml, 'a:r', { maxElements: MAX_UNLIMITED })) {
      if (!run.raw.endsWith(END_RUN_TAG)) continue;
      parts.push(xml.slice(from, run.startIndex), rewriteRun(run.raw, this.symbols));
      from = run.endIndex;
    }
    parts.push(xml.slice(from));
    return parts.join('');
  }

  /** Adds the warning lines of the replacements made so far to the running conversion. */
  report(): void {
    for (const line of this.symbols.warnings()) reportConversionWarning(line);
  }
}
