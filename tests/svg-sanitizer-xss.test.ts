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

describe('inline style rewrite keeps quote structure (item 3)', () => {
  it('escapes a double quote hidden in a single-quoted style value', () => {
    const out = sanitizeSvgString(`<svg><rect style='x"/onload="alert(1)'/></svg>`);
    const rect = parseTags(out).find((tag) => tag.name === 'rect');
    expect(rect?.attrs.map((attr) => attr.name)).toEqual(['style']);
    expect(rect?.attrs[0].quote).toBe('"');
    expect(rect?.attrs[0].value).toBe('x&quot;/onload=&quot;alert(1)');
    expect(executableConstructs(out)).toEqual([]);
  });

  it('escapes a double quote hidden in an unquoted style value', () => {
    const out = sanitizeSvgString('<svg><rect style=x"/onload="alert(1)/></svg>');
    expect(parseTags(out).flatMap((tag) => tag.attrs.map((attr) => attr.name)).filter((name) => /^on/i.test(name))).toEqual([]);
    expect(out).toContain('style="x&quot;/onload=&quot;alert(1)/"');
  });

  it('keeps ordinary double-quoted styles unchanged', () => {
    expect(sanitizeSvgString('<svg><rect style="fill:red;stroke:blue"/></svg>')).toBe('<svg><rect style="fill:red;stroke:blue"/></svg>');
  });

  it('escapes double quotes of a single-quoted font-family style', () => {
    expect(sanitizeSvgString(`<svg><text style='font-family:"A"'/></svg>`)).toBe(
      '<svg><text style="font-family:&quot;A&quot;"/></svg>'
    );
  });
});

describe('on* attribute stripping without leading whitespace (item 4)', () => {
  const payloads: Array<[string, string]> = [
    ['slash separator', '<svg/onload=alert(1)>'],
    ['quote-adjacent attribute', '<svg a="b"onload=alert(1)>'],
    ['single-quote-adjacent attribute', "<svg a='b'onload=alert(1)>"],
    ['slash before quoted value', '<svg/onload="alert(1)"><rect/></svg>'],
    ['mixed case', '<svg a="b"/OnLoAd=alert(1)>'],
    ['whitespace around equals', '<svg\nonload\n=\n"alert(1)">'],
    ['namespaced handler', '<svg xmlns:x="u" x:onload="alert(1)">'],
  ];

  for (const [label, payload] of payloads) {
    it(`strips the handler: ${label}`, () => {
      const out = sanitizeSvgString(payload);
      expect(executableConstructs(out)).toEqual([]);
      expect(out.toLowerCase()).not.toContain('alert(1)');
    });
  }

  it('keeps the other attributes of a tag whose handler was stripped', () => {
    const out = sanitizeSvgString('<svg a="b"onload=alert(1) c="d"><rect/></svg>');
    expect(parseTags(out)[0].attrs).toEqual([
      { name: 'a', value: 'b', quote: '"' },
      { name: 'c', value: 'd', quote: '"' },
    ]);
  });

  it('does not alter text content or attribute values that merely mention on* names', () => {
    const input = '<svg><text title="see onload=1">press onclick=now, then a/onload=x</text></svg>';
    expect(sanitizeSvgString(input)).toBe(input);
  });

  it('keeps names that only start with on inside other words intact', () => {
    const input = '<svg><rect data-onion="1" fill="red"/></svg>';
    expect(sanitizeSvgString(input)).toBe('<svg><rect data-onion="1" fill="red"/></svg>');
  });

  it('removes an unterminated quoted handler through the end of input', () => {
    const out = sanitizeSvgString('<svg a="b"onload="alert(1)');
    expect(out).toBe('<svg a="b"');
  });

  it('strips handlers on a large tag in linear time', () => {
    const attrs = ' a="1"onload=x'.repeat(20000);
    const start = performance.now();
    const out = sanitizeSvgString(`<svg${attrs}>`);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out.startsWith('<svg a="1" a="1"')).toBe(true);
    expect(out).not.toContain('onload');
  });
});
