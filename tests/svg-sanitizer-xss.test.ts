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

const XML_NAMED = new Map([['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"]]);

/** XML character and predefined entity references, as an XML parser resolves them in text or attribute values. */
function xmlEntitiesDecoded(text: string): string {
  return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g, (_, hex?: string, dec?: string, name?: string) =>
    name === undefined ? String.fromCodePoint(hex === undefined ? Number(dec) : parseInt(hex, 16)) : (XML_NAMED.get(name) as string)
  );
}

/** Text of a <style> element as a parser sees it: CDATA content is literal, everything else has entities resolved. */
function elementTextAsParsed(body: string): string {
  return body
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((segment) => (segment.startsWith('<![CDATA[') ? segment.slice('<![CDATA['.length, -']]>'.length) : xmlEntitiesDecoded(segment)))
    .join('');
}

function cssLeaks(out: string): string[] {
  const found: string[] = [];
  const bodies = [
    ...[...out.matchAll(/<(?:[\w.-]+:)?style[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?style\s*>/gi)].map((m) => cssAsParsed(elementTextAsParsed(m[1]))),
    ...[...out.matchAll(/\sstyle="([^"]*)"/g)].map((m) => cssAsParsed(xmlEntitiesDecoded(m[1]))),
  ];
  for (const parsed of bodies) {
    if (/@import/i.test(parsed)) found.push(`@import in ${parsed}`);
    if (/url\(\s*['"]?(?:https?:|file:|ftp:|\/\/)/i.test(parsed)) found.push(`external url in ${parsed}`);
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

describe('URI and style rewrites apply only to real attributes (issue #401 item 2)', () => {
  const inertText: Array<[string, string]> = [
    ['text content', "<svg><text>style='a' href=javascript:alert(1) to=http://e/x values=https://e/y src=//e/z</text></svg>"],
    ['quoted attribute value', `<svg><rect title="style='a' href=javascript:1 to=http://e/x"/></svg>`],
    ['comment', '<svg><!-- style=\'a\' href=javascript:1 --><rect/></svg>'],
    ['stray angle bracket text', "<svg><text>1 > 0 style='a' href=javascript:1</text></svg>"],
  ];

  for (const [label, input] of inertText) {
    it(`leaves ${label} unchanged`, () => {
      expect(sanitizeSvgString(input)).toBe(input);
    });
  }

  it('neutralizes the real attributes while preserving the text next to them', () => {
    const out = sanitizeSvgString(
      "<svg><a href=javascript:alert(1)><text>href=javascript:alert(1)</text></a><rect style='fill:red'/></svg>"
    );
    expect(out).toBe('<svg><a href="#"><text>href=javascript:alert(1)</text></a><rect style="fill:red"/></svg>');
  });

  it('neutralizes animation value attributes only inside tags', () => {
    const out = sanitizeSvgString(
      '<svg><set attributeName="x" to=http://e/x /><animate values="1;https://e/y" from="//e/z"/><text>to=http://e/x</text></svg>'
    );
    expect(out).toBe('<svg><set attributeName="x" to="#" /><animate values="#" from="#"/><text>to=http://e/x</text></svg>');
  });

  it('neutralizes xlink:href, src and quote-adjacent attributes', () => {
    const out = sanitizeSvgString(`<svg><use a="b"xlink:href='jav&#x61;script:alert(1)'/><image src="//e/x.png"/></svg>`);
    expect(parseTags(out).flatMap((tag) => tag.attrs.map((attr) => `${tag.name}:${attr.name}=${attr.value}`))).toEqual([
      'use:a=b',
      'use:href=#',
      'image:href=#',
    ]);
  });

  it('sanitizes a style attribute only inside a tag and still cleans it', () => {
    const out = sanitizeSvgString(
      `<svg><text>style="fill:url(http://e/x)"</text><rect style="fill:url(http://e/x)"/></svg>`
    );
    expect(out).toBe(`<svg><text>style="fill:url(http://e/x)"</text><rect style="fill:none"/></svg>`);
  });
});

describe('style-targeting animations (issue #401 item 3)', () => {
  const hostile = [
    '<set attributeName="style" to="fill:url(http://e/x)"/>',
    '<animate attributeName="style" values="fill:red;@import url(x.css)"/>',
    '<animate attributeName="style" from="a:b" to="background:url(//e/x)"/>',
    '<animateTransform attributeName="style" by="fill:url(https://e/x)"/>',
    '<SET AttributeName="STYLE" to="x:expression(alert(1))"/>',
    '<set attributeName="&#115;tyle" to="fill:url( &quot;http://e/x&quot;)"/>',
    '<set attributeName="svg:style" to="behavior:javascript:alert(1)"/>',
    '<set attributeName=" st&#x79;le " to="x: Expression (alert(1))"/>',
    '<set attributeName="style" to="@\\69mport url(x.css)"/>',
    '<set attributeName="style" to="u\\72l(http://e/x)"/>',
    '<set attributeName="style" to="ur/**/l(http://e/x)"/>',
    '<animateTransform attributeName="onbegin" type="rotate" to="alert(1)"/>',
    '<animateMotion attributeName="onend" path="M0 0" to="alert(1)"/>',
    '<animateTransform attributeName="xlink:href" to="javascript:alert(1)"/>',
    '<animate attributeName="href" values="#a;&#106;avascript:alert(1)"/>',
    '<animate attributeName="href" values="#a;jav&#x61;script&#58;alert(1)"/>',
  ];

  for (const animation of hostile) {
    it(`removes ${animation}`, () => {
      const out = sanitizeSvgString(`<svg><rect>${animation}<circle/></rect></svg>`);
      expect(out).toBe('<svg><rect><circle/></rect></svg>');
    });
  }

  const benign = [
    '<set attributeName="style" to="fill:red"/>',
    '<animate attributeName="style" values="fill:url(#a);fill:url(#b)" dur="1s"/>',
    '<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="2s"/>',
    '<animateMotion path="M0 0L9 9" dur="1s"/>',
    '<set attributeName="class" to="javascript-theme"/>',
  ];

  for (const animation of benign) {
    it(`keeps ${animation}`, () => {
      const input = `<svg><rect>${animation}</rect></svg>`;
      expect(sanitizeSvgString(input)).toBe(input);
    });
  }
});

describe('namespace-prefixed <style> elements (issue #401 item 4)', () => {
  it('cleans the body of a prefixed style element like an unprefixed one', () => {
    const out = sanitizeSvgString(
      '<svg xmlns:s="http://www.w3.org/2000/svg"><s:style type="text/css">@import url(http://e/x.css);g{fill:url(http://e/y)}h{fill:red}</s:style></svg>'
    );
    expect(out).toBe('<svg xmlns:s="http://www.w3.org/2000/svg"><s:style>g{fill:none}h{fill:red}</s:style></svg>');
  });

  it('cleans escape-obfuscated prefixed style bodies, with a mixed-case prefix and name', () => {
    const out = sanitizeSvgString('<svg><S:STYLE>@\\69mport "http://e/x.css";g{fill:u\\72l(http://e/y)}</S:STYLE ></svg>');
    expect(out).toBe('<svg><S:STYLE>g{fill:none}</S:STYLE></svg>');
    expect(cssLeaks(out)).toEqual([]);
  });

  it('cleans an unterminated prefixed style element and several in one document', () => {
    const out = sanitizeSvgString('<svg><a.b:style>@import "http://e/x";</a.b:style><s:style>g{fill:url(//e/z)}');
    expect(out).toBe('<svg><a.b:style></a.b:style><s:style>g{fill:none}</s:style>');
  });

  it('leaves names that only contain style untouched', () => {
    const input = '<svg><s:styled>@import "http://e/x";</s:styled><restyle/></svg>';
    expect(sanitizeSvgString(input)).toBe(input);
  });

  it('keeps benign prefixed style bodies unchanged', () => {
    const input = '<svg><s:style>g{fill:url(#a);stroke:#000}</s:style></svg>';
    expect(sanitizeSvgString(input)).toBe(input);
  });

  it('handles many prefixed style openers in linear time', () => {
    const payload = `<svg>${Array.from({ length: 20000 }, (_, i) => `<p${i}:style>`).join('')}</svg>`;
    const start = performance.now();
    sanitizeSvgString(payload);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('XML entity layer before CSS matching (issue #401 entity follow-up)', () => {
  const encoded: Array<[string, string]> = [
    ['hex reference for @', '&#x40;import url(http://e/x.css);g{fill:blue}'],
    ['decimal reference for @', '&#64;import url(http://e/x.css);g{fill:blue}'],
    ['padded reference', '&#x000040;import url(http://e/x.css);g{fill:blue}'],
    ['reference inside url keyword', 'g{fill:u&#114;l(http://e/x)}'],
    ['reference inside scheme', 'g{fill:url(h&#x74;tp://e/x)}'],
    ['reference producing a CSS escape', '@&#92;69mport url(http://e/x.css);g{fill:blue}'],
    ['hex backslash reference', '@&#x5c;000069mport "http://e/x.css";g{fill:blue}'],
    ['reference producing a comment', 'g{fill:ur&#47;**&#47;l(http://e/x)}'],
    ['reference producing an escaped newline', 'g{fill:ur&#92;&#10;l(http://e/x)}'],
    ['astral reference beside a hit', 'g{content:"&#x1F600;"}&#64;import "http://e/x";'],
  ];

  for (const [label, css] of encoded) {
    it(`neutralizes in a <style> body: ${label}`, () => {
      const out = sanitizeSvgString(`<svg><style>${css}</style></svg>`);
      expect(cssLeaks(out)).toEqual([]);
      expect(sanitizeSvgString(out)).toBe(out);
    });

    it(`neutralizes in a style attribute: ${label}`, () => {
      const out = sanitizeSvgString(`<svg><rect style='${css}'/></svg>`);
      expect(cssLeaks(out)).toEqual([]);
      expect(sanitizeSvgString(out)).toBe(out);
    });
  }

  it('removes only the encoded rule and keeps the rest byte-for-byte', () => {
    expect(sanitizeSvgString('<svg><style>&#x40;import url(http://e/x.css);g{fill:blue}</style></svg>')).toBe(
      '<svg><style>g{fill:blue}</style></svg>'
    );
    expect(sanitizeSvgString('<svg><style>g{fill:u&#114;l(http://e/x)}h{fill:red}</style></svg>')).toBe(
      '<svg><style>g{fill:none}h{fill:red}</style></svg>'
    );
  });

  it('treats CDATA content in <style> as literal for entities but still cleans real rules', () => {
    const literal = '<svg><style><![CDATA[&#x40;import x;g{fill:blue}]]></style></svg>';
    expect(sanitizeSvgString(literal)).toBe(literal);
    expect(sanitizeSvgString('<svg><style><![CDATA[@import url(http://e/x.css);g{fill:blue}]]></style></svg>')).toBe(
      '<svg><style><![CDATA[g{fill:blue}]]></style></svg>'
    );
    expect(cssLeaks(sanitizeSvgString('<svg><style><![CDATA[@\\69mport "http://e/x";]]>&#64;import "http://e/y";</style></svg>'))).toEqual([]);
    expect(() => sanitizeSvgString('<svg><style><![CDATA[&#0;]]></style></svg>')).not.toThrow(SvgSanitizationError);
  });

  it('fails closed on numeric references to invalid code points', () => {
    for (const bad of ['&#0;', '&#x0;', '&#xD800;', '&#55296;', '&#x110000;', '&#99999999999999999999;', '&#92;110000 ']) {
      expect(() => sanitizeSvgString(`<svg><style>g{content:"${bad}"}</style></svg>`)).toThrow(SvgSanitizationError);
      expect(() => sanitizeSvgString(`<svg><rect style='content:"${bad}"'/></svg>`)).toThrow(SvgSanitizationError);
    }
  });

  it('keeps benign entities, malformed references and valid CSS intact', () => {
    const css = 'g{content:"a &amp; b &lt; c &#x41; &#66; & &# &#x; &foo;";fill:url(#a)}';
    expect(sanitizeSvgString(`<svg><style>${css}</style></svg>`)).toBe(`<svg><style>${css}</style></svg>`);
  });

  describe('linear time on 5 MB adversarial entity input', () => {
    const FIVE_MB = 5 * 1024 * 1024;
    const BUDGET_MS = 2000;
    const adversarial: Array<[string, string]> = [
      ['bare reference openers', '&#'.repeat(FIVE_MB / 2)],
      ['unterminated hex run', `&#x${'0'.repeat(FIVE_MB)}`],
      ['unterminated decimal runs', '&#1'.repeat(FIVE_MB / 3)],
      ['ampersands', '&'.repeat(FIVE_MB)],
      ['encoded imports', '&#x40;import a;'.repeat(Math.floor(FIVE_MB / 15))],
      ['encoded backslash imports', '@&#92;69mport a;'.repeat(Math.floor(FIVE_MB / 16))],
      ['encoded urls', 'u&#114;l(http://e/x)'.repeat(Math.floor(FIVE_MB / 20))],
      ['CDATA openers', '<![CDATA['.repeat(FIVE_MB / 9)],
      ['CDATA pairs', '<![CDATA[&#]]>'.repeat(Math.floor(FIVE_MB / 14))],
    ];

    for (const [label, css] of adversarial) {
      for (const [place, wrap] of [
        ['a <style> body', (c: string) => `<svg><style>${c}</style></svg>`],
        ['a style attribute', (c: string) => `<svg><rect style='${c.replace(/'/g, '&apos;')}'/></svg>`],
      ] as Array<[string, (c: string) => string]>) {
        it(`handles ${label} in ${place}`, () => {
          const start = performance.now();
          const out = sanitizeSvgString(wrap(css));
          expect(performance.now() - start).toBeLessThan(BUDGET_MS);
          // The oracle's own CDATA splitter is not linear, so the output scan skips the CDATA-heavy inputs.
          if (!label.startsWith('CDATA')) expect(cssLeaks(out)).toEqual([]);
        });
      }
    }
  });
});
