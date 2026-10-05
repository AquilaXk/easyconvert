import { describe, expect, it } from 'vitest';
import { sanitizeSvgString } from '../src/lib/security/svg-sanitizer';
import { SvgSanitizationError } from '../src/lib/types';

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

describe('@import, namespaced elements and animation targets (item 5)', () => {
  it('strips @import without whitespace before the target', () => {
    const out = sanitizeSvgString('<svg><style>@import"http://e/x.css";rect{fill:red}@import\'http://e/y.css\';</style></svg>');
    expect(out).toBe('<svg><style>rect{fill:red}</style></svg>');
  });

  it('strips @import url() without whitespace', () => {
    const out = sanitizeSvgString('<svg><style>@import url(http://e/x.css);g{fill:blue}</style></svg>');
    expect(out).toBe('<svg><style>g{fill:blue}</style></svg>');
  });

  it('strips namespace-prefixed dangerous elements with their content', () => {
    const out = sanitizeSvgString(
      '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script><x:foreignObject><p/></x:foreignObject><rect/></svg>'
    );
    expect(out).toBe('<svg xmlns:s="http://www.w3.org/2000/svg"><rect/></svg>');
  });

  it('strips prefixed openers that have no close tag and mixed-case prefixes', () => {
    const out = sanitizeSvgString('<svg><S:IFrame src="x"><rect/></svg>');
    expect(out).toBe('<svg><rect/></svg>');
    expect(sanitizeSvgString('<svg><a.b-c:embed/><rect/></svg>')).toBe('<svg><rect/></svg>');
  });

  it('keeps prefixed names that only contain a dangerous word', () => {
    const input = '<svg><s:scripted/><xlink:objects/><rect xlink:script="1"/></svg>';
    expect(sanitizeSvgString(input)).toBe(input);
  });

  it('strips many distinct prefixed openers in linear time', () => {
    const payload = `<svg>${Array.from({ length: 20000 }, (_, i) => `<p${i}:script>`).join('')}</svg>`;
    const start = performance.now();
    const out = sanitizeSvgString(payload);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out).toBe('<svg></svg>');
  });

  const hostileAnimations = [
    '<set attributeName="onmouseover" to="alert(1)"/>',
    '<animate attributeName="onclick" values="alert(1)"/>',
    '<SET AttributeName="OnBegin" to="alert(1)"></SET>',
    '<set attributeName="&#111;nclick" to="alert(1)"/>',
    '<set attributeName="xlink:href" to="javascript:alert(1)"/>',
    '<animate attributeName="href" values="#a;javascript:alert(1)"/>',
    '<s:set attributeName="onfocus" to="alert(1)"/>',
  ];

  for (const animation of hostileAnimations) {
    it(`removes the hostile animation ${animation}`, () => {
      const out = sanitizeSvgString(`<svg><a>${animation}<rect/></a></svg>`);
      expect(out).not.toContain('attributeName');
      expect(out.toLowerCase()).not.toContain('attributename');
      expect(out).not.toContain('alert(1)');
      expect(out).toContain('<rect/>');
      expect(executableConstructs(out)).toEqual([]);
    });
  }

  it('keeps benign animations', () => {
    const input = '<svg><rect><set attributeName="fill" to="red"/><animate attributeName="width" values="1;5" dur="1s"/></rect></svg>';
    expect(sanitizeSvgString(input)).toBe(input);
  });
});

describe('known SVG XSS payload corpus', () => {
  const corpus: Array<[string, string]> = [
    ['plain script', '<svg><script>alert(1)</script></svg>'],
    ['mixed-case script', '<svg><ScRiPt>alert(1)</sCrIpT ></svg>'],
    ['script with src and slash separator', '<svg><script/src=//evil.test/x.js></script></svg>'],
    ['self-closing script', '<svg><script src="data:,alert(1)"/></svg>'],
    ['split opener', '<svg><scr<script>ipt>alert(1)</script></svg>'],
    ['doubly split opener', '<svg><sc<script>r<script>ipt>ipt>alert(1)</script>ript></svg>'],
    ['split opener through @import', '<svg><style><scr@import x;ipt>alert(1)</scr@import y;ipt></style></svg>'],
    ['split opener through url()', '<svg><style><scr url(http://e/x)ipt>alert(1)</scr url(http://e/y)ipt></style></svg>'],
    ['script inside comment-looking text', '<svg><!----><script>alert(1)</script><!----></svg>'],
    ['script after unterminated comment opener', '<svg><!-><script>alert(1)</script>--></svg>'],
    ['script inside CDATA', '<svg><![CDATA[<script>alert(1)</script>]]></svg>'],
    ['script split by CDATA', '<svg><scr<![CDATA[x]]>ipt>alert(1)</script></svg>'],
    ['namespaced script', '<svg xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>'],
    ['foreignObject with html script', '<svg><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject></svg>'],
    ['namespaced foreignObject', '<svg><x:foreignObject><iframe srcdoc="x"/></x:foreignObject></svg>'],
    ['iframe', '<svg><iframe src="javascript:alert(1)"></iframe></svg>'],
    ['object and embed', '<svg><object data="javascript:alert(1)"/><embed src="javascript:alert(1)"/></svg>'],
    ['onload on root', '<svg onload="alert(1)"></svg>'],
    ['onload without whitespace', '<svg/onload=alert(1)>'],
    ['onload after quoted attribute', '<svg a="b"onload=alert(1)>'],
    ['upper-case handler', '<svg ONLOAD="alert(1)"><rect OnClick=alert(1) /></svg>'],
    ['handler on image', '<svg><image href="x" onerror="alert(1)"/></svg>'],
    ['handler with newline around equals', '<svg><rect onclick\n=\n"alert(1)"/></svg>'],
    ['handler on animate', '<svg><animate onbegin="alert(1)" attributeName="x" dur="1s"/></svg>'],
    ['handler on discard', '<svg><discard onbegin=alert(1)/></svg>'],
    ['javascript href', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
    ['javascript xlink:href', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
    ['mixed-case javascript href', '<svg><a href="jAvAsCrIpT:alert(1)"/></svg>'],
    ['entity-encoded javascript href', '<svg><a href="&#106;avascript:alert(1)"/></svg>'],
    ['hex entity-encoded javascript href', '<svg><a xlink:href="jav&#x61;script&#x3a;alert(1)"/></svg>'],
    ['tab-split javascript href', '<svg><a href="java&#x09;script:alert(1)"/></svg>'],
    ['unquoted javascript href', '<svg><a href=javascript:alert(1)><text>x</text></a></svg>'],
    ['vbscript href', '<svg><a href="vbscript:msgbox(1)"/></svg>'],
    ['data html href', '<svg><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="/></svg>'],
    ['data svg use', '<svg><use href="data:image/svg+xml;base64,PHN2Zy8+"/></svg>'],
    ['set retargeting href', '<svg><a><set attributeName="href" to="javascript:alert(1)"/><text>x</text></a></svg>'],
    ['animate values href', '<svg><a><animate attributeName="xlink:href" values="#a;javascript:alert(1)"/></a></svg>'],
    ['set onmouseover', '<svg><rect width="9" height="9"><set attributeName="onmouseover" to="alert(1)"/></rect></svg>'],
    ['animate onclick', '<svg><rect><animate attributeName="onclick" values="alert(1)" dur="1s"/></rect></svg>'],
    ['style single-quote breakout', `<svg><rect style='x"/onload="alert(1)'/></svg>`],
    ['style unquoted breakout', '<svg><rect style=x"/onload="alert(1)/></svg>'],
    ['style @import', '<svg><style>@import url(http://evil.test/x.css);</style></svg>'],
    ['style @import without space', '<svg><style>@import"http://evil.test/x.css";</style></svg>'],
    ['style external url', '<svg><style>rect{fill:url(http://evil.test/x)}</style></svg>'],
    ['style unterminated', '<svg><style><script>alert(1)</script>'],
    ['nested style openers', '<svg><style><style><script>alert(1)</script></style></style></svg>'],
    ['doctype entity', '<!DOCTYPE svg [<!ENTITY x "<script>alert(1)</script>">]><svg>&x;</svg>'],
    ['meta refresh', '<svg><meta http-equiv="refresh" content="0;url=javascript:alert(1)"/></svg>'],
  ];

  const HTML_ENTITY = /&#x([0-9a-f]+);|&#(\d+);/gi;
  function decodedValue(value: string): string {
    return value
      .replace(HTML_ENTITY, (_, hex: string | undefined, dec: string | undefined) =>
        String.fromCharCode(hex === undefined ? Number(dec) : parseInt(hex, 16))
      )
      .replace(/[\s\x00-\x1f]/g, '')
      .toLowerCase();
  }

  for (const [label, payload] of corpus) {
    it(`leaves no executable construct: ${label}`, () => {
      const out = sanitizeSvgString(payload);
      const lowered = out.toLowerCase();
      expect(lowered).not.toContain('<script');
      expect(lowered).not.toContain('<iframe');
      expect(lowered).not.toContain('<foreignobject');
      expect(lowered).not.toMatch(/<\w+:(?:script|foreignobject|iframe|object|embed)/);
      expect(executableConstructs(out)).toEqual([]);
      for (const tag of parseTags(out)) {
        for (const attr of tag.attrs) {
          expect(decodedValue(attr.value)).not.toMatch(/^(?:javascript|vbscript|data:text\/html|data:image\/svg\+xml):/);
          if (/^(?:xlink:)?href$/i.test(attr.name)) expect(decodedValue(attr.value)).not.toMatch(/^(?:https?:|file:|ftp:|\/\/)/);
        }
      }
      expect(sanitizeSvgString(out)).toBe(out);
    });
  }
});

/** Independent CSS reader for the oracle: strips comments, then decodes escapes (CSS Syntax 4.3.7). */
function cssAsParsed(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
    .replace(/\\(?:[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\r\n|[\n\r\f]|([\s\S]))/g, (whole: string, literal: string | undefined) => {
      if (literal !== undefined) return literal;
      const hex = /^\\([0-9a-fA-F]{1,6})/.exec(whole);
      return hex === null ? '' : String.fromCodePoint(parseInt(hex[1], 16));
    });
}

function cssLeaks(out: string): string[] {
  const found: string[] = [];
  const bodies = [
    ...[...out.matchAll(/<(?:[\w.-]+:)?style[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?style\s*>/gi)].map((m) => m[1]),
    ...[...out.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]),
  ];
  for (const body of bodies) {
    const parsed = cssAsParsed(body);
    if (/@import/i.test(parsed)) found.push(`@import in ${body}`);
    if (/url\(\s*['"]?(?:https?:|file:|ftp:|\/\/)/i.test(parsed)) found.push(`external url in ${body}`);
  }
  return found;
}

describe('CSS escape and comment obfuscation (issue #401 item 1)', () => {
  const obfuscated: Array<[string, string]> = [
    ['escaped i in @import', '@\\69mport url(http://e/x.css);g{fill:blue}'],
    ['six-digit escape in @import', '@\\000069mport "http://e/x.css";g{fill:blue}'],
    ['escape terminated by whitespace', '@\\69 mport url(http://e/x.css);g{fill:blue}'],
    ['comment inside @import', '@im/**/port url(http://e/x.css);g{fill:blue}'],
    ['escaped url keyword', 'g{fill:u\\72l(http://e/x)}'],
    ['escaped first url letter', 'g{fill:\\75rl(http://e/x)}'],
    ['escaped scheme', 'g{fill:url(\\68ttp://e/x)}'],
    ['escaped quote and scheme', 'g{fill:url(\\22 http://e/x\\22 )}'],
    ['comment inside url', 'g{fill:ur/**/l(http://e/x)}'],
    ['escaped newline inside url', 'g{fill:ur\\\nl(http://e/x)}'],
    ['escaped slashes', 'g{fill:url(http:\\2f\\2fe/x)}'],
    ['literal escape of ordinary letter', 'g{fill:\\u\\r\\l(http://e/x)}'],
  ];

  for (const [label, css] of obfuscated) {
    it(`neutralizes in a <style> body: ${label}`, () => {
      const out = sanitizeSvgString(`<svg><style>${css}</style></svg>`);
      expect(cssLeaks(out)).toEqual([]);
      expect(out).toContain('g{fill:');
      expect(sanitizeSvgString(out)).toBe(out);
    });

    it(`neutralizes in a style attribute: ${label}`, () => {
      const out = sanitizeSvgString(`<svg><rect style="${css.replace(/"/g, '&quot;')}"/></svg>`);
      expect(cssLeaks(out)).toEqual([]);
      expect(sanitizeSvgString(out)).toBe(out);
    });
  }

  it('removes the obfuscated rule and keeps the neighbouring rule byte-for-byte', () => {
    expect(sanitizeSvgString('<svg><style>@\\69mport url(http://e/x.css);g{fill:blue}</style></svg>')).toBe(
      '<svg><style>g{fill:blue}</style></svg>'
    );
    expect(sanitizeSvgString('<svg><style>g{fill:u\\72l(http://e/x)}</style></svg>')).toBe(
      '<svg><style>g{fill:none}</style></svg>'
    );
  });

  it('fails closed on escapes that decode to an invalid code point', () => {
    for (const bad of ['\\0 x', '\\000000x', '\\110000 x', '\\D800 x', '\\dfff x']) {
      expect(() => sanitizeSvgString(`<svg><style>g{content:"${bad}"}</style></svg>`)).toThrow(SvgSanitizationError);
      expect(() => sanitizeSvgString(`<svg><rect style='content:"${bad}"'/></svg>`)).toThrow(SvgSanitizationError);
    }
  });

  it('keeps benign CSS (id references, colors, fonts, comments, valid escapes) intact', () => {
    const css = '/* note */.a{fill:url(#grad);stroke:#fff;font-family:"A\\5FAE Hei",sans-serif}.b::after{content:"\\201C"}';
    expect(sanitizeSvgString(`<svg><style>${css}</style></svg>`)).toBe(`<svg><style>${css}</style></svg>`);
    expect(sanitizeSvgString('<svg><rect style="fill:url(#g);stroke:rgb(0,0,0)"/></svg>')).toBe(
      '<svg><rect style="fill:url(#g);stroke:rgb(0,0,0)"/></svg>'
    );
  });

  describe('linear time on 5 MB adversarial CSS', () => {
    const FIVE_MB = 5 * 1024 * 1024;
    const BUDGET_MS = 2000;
    const adversarial: Array<[string, string]> = [
      ['backslashes', '\\'.repeat(FIVE_MB / 2)],
      ['escape digits', '\\6'.repeat(FIVE_MB / 3)],
      ['comment openers', '/*'.repeat(FIVE_MB / 2)],
      ['closed empty comments', '/**/'.repeat(FIVE_MB / 4)],
      ['obfuscated imports', '@\\69mport a;'.repeat(Math.floor(FIVE_MB / 13))],
      ['obfuscated urls', 'u\\72l(http://e/x)'.repeat(Math.floor(FIVE_MB / 18))],
      ['unterminated urls', 'ur/**/l(http://'.repeat(Math.floor(FIVE_MB / 15))],
    ];

    for (const [label, css] of adversarial) {
      it(`handles ${label}`, () => {
        const start = performance.now();
        const out = sanitizeSvgString(`<svg><style>${css}</style></svg>`);
        expect(performance.now() - start).toBeLessThan(BUDGET_MS);
        expect(cssLeaks(out)).toEqual([]);
      });
    }
  });
});
