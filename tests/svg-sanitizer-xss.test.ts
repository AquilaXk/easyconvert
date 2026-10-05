import { describe, expect, it } from 'vitest';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';

/** Independent quote-aware tag tokenizer used as the oracle; it shares no code with the sanitizer. */
interface ParsedTag {
  name: string;
  attrs: Array<{ name: string; value: string; quote: string }>;
}

function parseTags(markup: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  const tagStart = /<([A-Za-z_][^\s/>]*)/g;
  let match: RegExpExecArray | null;
  while ((match = tagStart.exec(markup)) !== null) {
    const attrs: ParsedTag['attrs'] = [];
    let i = match.index + match[0].length;
    for (;;) {
      while (i < markup.length && /[\s/]/.test(markup[i])) i++;
      if (i >= markup.length || markup[i] === '>') break;
      const nameStart = i;
      while (i < markup.length && !/[\s/>=]/.test(markup[i])) i++;
      const name = markup.slice(nameStart, i);
      let value = '';
      let quote = '';
      let k = i;
      while (k < markup.length && /\s/.test(markup[k])) k++;
      if (markup[k] === '=') {
        k++;
        while (k < markup.length && /\s/.test(markup[k])) k++;
        if (markup[k] === '"' || markup[k] === "'") {
          quote = markup[k];
          const close = markup.indexOf(quote, k + 1);
          const end = close === -1 ? markup.length : close;
          value = markup.slice(k + 1, end);
          i = Math.min(end + 1, markup.length);
        } else {
          const valueStart = k;
          while (k < markup.length && !/[\s>]/.test(markup[k])) k++;
          value = markup.slice(valueStart, k);
          i = k;
        }
      }
      if (name.length === 0) {
        i++;
        continue;
      }
      attrs.push({ name, value, quote });
    }
    tags.push({ name: match[1], attrs });
    tagStart.lastIndex = Math.max(tagStart.lastIndex, i);
  }
  return tags;
}

const LOCAL_NAME = /^(?:.*:)?/;
const FORBIDDEN_ELEMENTS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed']);

/** Returns every executable construct found in sanitized output; an empty list means the output is inert. */
function executableConstructs(markup: string): string[] {
  const found: string[] = [];
  for (const tag of parseTags(markup)) {
    const local = tag.name.replace(LOCAL_NAME, '').toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(local)) found.push(`element:${tag.name}`);
    for (const attr of tag.attrs) {
      const attrLocal = attr.name.replace(LOCAL_NAME, '').toLowerCase();
      if (attrLocal.startsWith('on')) found.push(`attribute:${attr.name}`);
      if (/^\s*(?:javascript|vbscript):/i.test(attr.value)) found.push(`uri:${attr.name}`);
    }
  }
  return found;
}

describe('SVG sanitizer output is a fixed point of dangerous-markup removal (item 2)', () => {
  it('does not rebuild <script> from fragments joined by @import removal', () => {
    const out = sanitizeSvgString('<svg><style><scr@import x;ipt>alert(1)</scr@import y;ipt></style></svg>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('</script');
    expect(executableConstructs(out)).toEqual([]);
  });

  it('does not rebuild an event handler from fragments joined by href rewriting', () => {
    const out = sanitizeSvgString('<svg><rect title="x href=javascript:1 onclick=alert(1)"/></svg>');
    expect(executableConstructs(out)).toEqual([]);
  });

  it('is idempotent on its own output', () => {
    const inputs = [
      '<svg><style><scr@import x;ipt>alert(1)</scr@import y;ipt></style></svg>',
      '<svg><a href="javascript:alert(1)"><rect style="fill:red"/></a></svg>',
    ];
    for (const input of inputs) {
      const once = sanitizeSvgString(input);
      expect(sanitizeSvgString(once)).toBe(once);
    }
  });
});
