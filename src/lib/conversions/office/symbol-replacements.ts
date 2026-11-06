import { mapSymbolFontCharacter, symbolReplacementWarning, undrawableSymbolWarning } from '../symbol-font-map';

const REPLACEMENT_CHARACTER = '\uFFFD';
/** Most replaced symbol characters listed one by one; the rest are counted in a final line. */
export const MAX_REPORTED_SYMBOL_REPLACEMENTS = 50;

/**
 * The symbol-font characters of one document, shared by the presentation readers: each private-use code is mapped to the
 * character its font draws, and one that has no counterpart (or whose counterpart the output cannot draw) is replaced by
 * U+FFFD and reported once per font and code.
 */
export class SymbolReplacements {
  private readonly replaced = new Map<string, string>();
  private total = 0;

  /** `canDraw`: whether the output can draw a character (the glyph coverage of a PDF); absent when it has no limit. */
  constructor(private readonly canDraw?: (character: string) => boolean) {}

  /** The character a private-use code depicts in `font` (undefined when the run names none), or U+FFFD. */
  character(font: string | undefined, code: number): string {
    const mapped = font === undefined ? undefined : mapSymbolFontCharacter(font, code);
    if (mapped === undefined) {
      this.record(font, code, symbolReplacementWarning(font, code));
      return REPLACEMENT_CHARACTER;
    }
    if (this.canDraw !== undefined && !this.canDraw(mapped)) {
      this.record(font, code, undrawableSymbolWarning(font, code, mapped));
      return REPLACEMENT_CHARACTER;
    }
    return mapped;
  }

  /** One line per replaced font and code, at most MAX_REPORTED_SYMBOL_REPLACEMENTS, then a line that counts the rest. */
  warnings(): string[] {
    const lines = [...this.replaced.values()];
    const unlisted = this.total - this.replaced.size;
    if (unlisted > 0) lines.push(`Replaced ${unlisted} more private-use characters with U+FFFD.`);
    return lines;
  }

  private record(font: string | undefined, code: number, warning: string): void {
    const key = `${font ?? ''}|${code}`;
    if (this.replaced.has(key)) return;
    this.total++;
    if (this.replaced.size >= MAX_REPORTED_SYMBOL_REPLACEMENTS) return;
    this.replaced.set(key, warning);
  }
}
