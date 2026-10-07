/**
 * A reader for ToUnicode CMap streams written from ISO 32000-1 section 9.10.3 and Adobe Technical Note 5014
 * (bfchar and bfrange). It shares no code with the generator under test, so a generated CMap is checked by
 * decoding it the way a PDF consumer does and comparing the mapping with what was meant.
 */

export interface CMapRange {
  /** Inclusive source code bounds. */
  first: number;
  last: number;
  /** Destination string for `first`; the last UTF-16 code unit increases by one per code. */
  destination: string;
}

export interface ToUnicodeCMap {
  name: string | null;
  /** `[low, high]` of each codespace range, with the byte width of the source codes. */
  codespaces: Array<{ low: number; high: number; bytes: number }>;
  bfchars: Map<number, string>;
  bfranges: CMapRange[];
}

const HEX_TOKEN = /<([0-9A-Fa-f\s]*)>/g;

function utf16BeToString(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 4 !== 0) throw new Error(`destination <${clean}> is not whole UTF-16BE code units`);
  let out = '';
  for (let i = 0; i < clean.length; i += 4) out += String.fromCharCode(Number.parseInt(clean.slice(i, i + 4), 16));
  return out;
}

function hexTokens(block: string): string[] {
  return [...block.matchAll(HEX_TOKEN)].map((m) => m[1].replace(/\s+/g, ''));
}

function sectionsOf(text: string, begin: string, end: string): string[] {
  const sections: string[] = [];
  const pattern = new RegExp(`\\d+\\s+${begin}([\\s\\S]*?)${end}`, 'g');
  for (const match of text.matchAll(pattern)) sections.push(match[1]);
  return sections;
}

export function readToUnicodeCMap(text: string): ToUnicodeCMap {
  const name = /\/CMapName\s*\/([^\s]+)\s+def/.exec(text)?.[1] ?? null;
  const codespaces: ToUnicodeCMap['codespaces'] = [];
  for (const section of sectionsOf(text, 'begincodespacerange', 'endcodespacerange')) {
    const tokens = hexTokens(section);
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      codespaces.push({ low: Number.parseInt(tokens[i], 16), high: Number.parseInt(tokens[i + 1], 16), bytes: tokens[i].length / 2 });
    }
  }
  const bfchars = new Map<number, string>();
  for (const section of sectionsOf(text, 'beginbfchar', 'endbfchar')) {
    const tokens = hexTokens(section);
    for (let i = 0; i + 1 < tokens.length; i += 2) bfchars.set(Number.parseInt(tokens[i], 16), utf16BeToString(tokens[i + 1]));
  }
  const bfranges: CMapRange[] = [];
  for (const section of sectionsOf(text, 'beginbfrange', 'endbfrange')) {
    const tokens = hexTokens(section);
    for (let i = 0; i + 2 < tokens.length; i += 3) {
      bfranges.push({
        first: Number.parseInt(tokens[i], 16),
        last: Number.parseInt(tokens[i + 1], 16),
        destination: utf16BeToString(tokens[i + 2]),
      });
    }
  }
  return { name, codespaces, bfchars, bfranges };
}

/** What a consumer maps `code` to: a bfchar entry, else the range holding it, else undefined. */
export function lookupCode(cmap: ToUnicodeCMap, code: number): string | undefined {
  const direct = cmap.bfchars.get(code);
  if (direct !== undefined) return direct;
  for (const range of cmap.bfranges) {
    if (code >= range.first && code <= range.last) {
      const head = range.destination.slice(0, -1);
      const lastUnit = range.destination.charCodeAt(range.destination.length - 1) + (code - range.first);
      return head + String.fromCharCode(lastUnit);
    }
  }
  return undefined;
}
