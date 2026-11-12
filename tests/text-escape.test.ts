import { describe, expect, it } from 'vitest';
import { escapeHtmlQuoted, escapeMarkupAttribute, escapeMarkupText, escapeXmlQuoted } from '../src/lib/text/escape';

/** The replace chains the writers carried before they shared this module, kept verbatim as the oracle. */
const referenceText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const referenceAttribute = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const referenceXmlQuoted = (s: string) => referenceAttribute(s).replace(/'/g, '&apos;');
const referenceHtmlQuoted = (s: string) => referenceAttribute(s).replace(/'/g, '&#39;');
/** The attribute-order variants the maskers carried: quote before the angle brackets. */
const referenceAttributeQuoteFirst = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const VARIANTS: Array<[string, (s: string) => string, (s: string) => string]> = [
  ['escapeMarkupText', escapeMarkupText, referenceText],
  ['escapeMarkupAttribute', escapeMarkupAttribute, referenceAttribute],
  ['escapeXmlQuoted', escapeXmlQuoted, referenceXmlQuoted],
  ['escapeHtmlQuoted', escapeHtmlQuoted, referenceHtmlQuoted],
];

const MAX_CODE_POINT = 0x10ffff;
const CHUNK = 4096;

function* codePointChunks(): Generator<string> {
  for (let start = 0; start <= MAX_CODE_POINT; start += CHUNK) {
    const codes: number[] = [];
    for (let code = start; code < start + CHUNK && code <= MAX_CODE_POINT; code++) {
      // Lone surrogates are valid JavaScript strings; String.fromCodePoint accepts them.
      codes.push(code);
    }
    yield String.fromCodePoint(...codes);
  }
}

/** Small deterministic generator so a failure reproduces. */
function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

describe.each(VARIANTS)('%s', (_name, escape, reference) => {
  it('matches the replace chain on every code point from U+0000 to U+10FFFF', () => {
    for (const chunk of codePointChunks()) expect(escape(chunk) === reference(chunk)).toBe(true);
  });

  it('matches the replace chain on each code point alone around the special characters', () => {
    for (let code = 0; code < 0x300; code++) {
      const single = String.fromCodePoint(code);
      expect(escape(single)).toBe(reference(single));
    }
  });

  it('matches the replace chain on edge cases', () => {
    const cases = [
      '', 'plain', '&', '<', '>', '"', "'", '&&', '&amp;', '&lt;&gt;', '&quot;', '&#39;', "&apos;", '<a href="x">it\'s</a>',
      '\ud800', '\udc00', '😀', '\udc00\ud800', 'a\ud800&', '\u0000&\u001f<\u007f', '￾￿"', '\r\n\t&',
      '&'.repeat(1000), "'".repeat(1000), '<'.repeat(3) + '>'.repeat(3),
    ];
    for (const text of cases) expect(escape(text)).toBe(reference(text));
  });

  it('matches the replace chain on random strings built from the special characters and arbitrary code points', () => {
    const next = xorshift(0x2545f491);
    const specials = ['&', '<', '>', '"', "'", ';', '#', 'a', ' ', '\n'];
    for (let round = 0; round < 3000; round++) {
      let text = '';
      const length = next() % 40;
      for (let i = 0; i < length; i++) {
        text += next() % 3 === 0 ? String.fromCodePoint(next() % (MAX_CODE_POINT + 1)) : specials[next() % specials.length];
      }
      expect(escape(text)).toBe(reference(text));
    }
  });
});

describe('the attribute variant against the maskers that applied the quote before the angle brackets', () => {
  it('writes the same text, since the ampersand goes first in both orders', () => {
    for (const chunk of codePointChunks()) expect(escapeMarkupAttribute(chunk) === referenceAttributeQuoteFirst(chunk)).toBe(true);
    for (const text of ['<"&">', '&quot;"', '""&&<>']) expect(escapeMarkupAttribute(text)).toBe(referenceAttributeQuoteFirst(text));
  });
});

describe('what each variant leaves alone', () => {
  it('keeps quotes out of text and the apostrophe out of attributes', () => {
    expect(escapeMarkupText('"\'')).toBe('"\'');
    expect(escapeMarkupAttribute('"\'')).toBe('&quot;\'');
    expect(escapeXmlQuoted('"\'')).toBe('&quot;&apos;');
    expect(escapeHtmlQuoted('"\'')).toBe('&quot;&#39;');
  });

  it('does not strip control characters or surrogates, which is why XML 1.0 writers keep their own escapers', () => {
    expect(escapeMarkupAttribute('\u0001\ud800')).toBe('\u0001\ud800');
  });
});
