import { describe, it, expect, vi, afterEach } from 'vitest';
import MarkdownIt from 'markdown-it';
import { convertFile } from '../src/lib/conversions/index';
import {
  MAX_MARKDOWN_ATTRIBUTE_CHARS,
  MAX_MARKDOWN_BLOCK_TOKENS,
  MAX_MARKDOWN_SOURCE_CHARS,
  MAX_MARKDOWN_TOTAL_TOKENS,
  MarkdownSanitizationError,
  applyTokenPolicy,
  renderMarkdownFragment,
} from '../src/lib/conversions/markdown';
import { ConversionFailedError } from '../src/lib/types';
import {
  collectAttributes,
  collectBodyText,
  collectText,
  findDangerousConstructs,
} from './helpers/html-dom-oracle';

async function mdToHtml(markdown: string, filename = 'doc.md'): Promise<string> {
  const result = await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'html', {}, filename);
  expect(result.mimeType).toBe('text/html');
  return result.buffer.toString('utf-8');
}

interface XssVector {
  name: string;
  markdown: string;
  /** Text a reader must still see in the body: the input is displayed, not silently dropped. */
  visible: string;
}

const XSS_VECTORS: XssVector[] = [
  { name: 'script block', markdown: '<script>alert(1)</script>', visible: '<script>alert(1)</script>' },
  {
    name: 'inline script',
    markdown: 'text <script>alert(1)</script> text',
    visible: 'text <script>alert(1)</script> text',
  },
  { name: 'img onerror', markdown: '<img src=x onerror=alert(1)>', visible: '<img src=x onerror=alert(1)>' },
  {
    name: 'inline img onerror',
    markdown: 'before <img src=x onerror=alert(1)> after',
    visible: 'before <img src=x onerror=alert(1)> after',
  },
  { name: 'javascript link', markdown: '[a](javascript:alert(1))', visible: '[a](javascript:alert(1))' },
  {
    name: 'mixed-case javascript link',
    markdown: '[a](JaVaScRiPt:alert(1))',
    visible: '[a](JaVaScRiPt:alert(1))',
  },
  {
    name: 'raw anchor with mixed-case scheme',
    markdown: '<a href="JaVaScRiPt:alert(1)">x</a>',
    visible: '<a href="JaVaScRiPt:alert(1)">x</a>',
  },
  { name: 'decimal entity scheme', markdown: '[a](&#106;avascript:alert(1))', visible: '[a](javascript:alert(1))' },
  { name: 'hex entity scheme', markdown: '[a](&#x6A;avascript:alert(1))', visible: '[a](javascript:alert(1))' },
  { name: 'named entity colon', markdown: '[a](javascript&colon;alert(1))', visible: '[a](javascript:alert(1))' },
  {
    name: 'raw anchor with entity scheme',
    markdown: '<a href="&#x6A;avascript:alert(1)">x</a>',
    visible: '<a href="javascript:alert(1)">x</a>',
  },
  {
    name: 'raw anchor with entity colon',
    markdown: '<a href="javascript&colon;alert(1)">x</a>',
    visible: '<a href="javascript:alert(1)">x</a>',
  },
  // A tab inside the scheme is percent-encoded, which makes the destination relative and inert.
  { name: 'control character inside scheme', markdown: '[a](<java\tscript:alert(1)>)', visible: 'a' },
  {
    name: 'leading whitespace scheme',
    markdown: '[a](<  javascript:alert(1)>)',
    visible: '[a](<  javascript:alert(1)>)',
  },
  { name: 'vbscript link', markdown: '[a](vbscript:msgbox(1))', visible: '[a](vbscript:msgbox(1))' },
  {
    name: 'data html link',
    markdown: '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    visible: '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  },
  {
    name: 'reference style javascript link',
    markdown: '[a][r]\n\n[r]: javascript:alert(1)',
    visible: '[r]: javascript:alert(1)',
  },
  { name: 'javascript autolink', markdown: '<javascript:alert(1)>', visible: '<javascript:alert(1)>' },
  { name: 'javascript image src', markdown: '![x](javascript:alert(1))', visible: '![x](javascript:alert(1))' },
  {
    name: 'svg data image',
    markdown: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
    visible: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
  },
  { name: 'svg onload', markdown: '<svg onload=alert(1)></svg>', visible: '<svg onload=alert(1)></svg>' },
  { name: 'svg slash onload', markdown: '<svg/onload=alert(1)>', visible: '<svg/onload=alert(1)>' },
  {
    name: 'svg with nested script',
    markdown: '<svg><script>alert(1)</script></svg>',
    visible: '<svg><script>alert(1)</script></svg>',
  },
  {
    name: 'iframe',
    markdown: '<iframe src="https://example.com"></iframe>',
    visible: '<iframe src="https://example.com"></iframe>',
  },
  {
    name: 'iframe javascript src',
    markdown: '<iframe src="javascript:alert(1)"></iframe>',
    visible: '<iframe src="javascript:alert(1)"></iframe>',
  },
  { name: 'iframe srcdoc', markdown: '<iframe srcdoc="<script>alert(1)</script>"></iframe>', visible: '<iframe srcdoc=' },
  { name: 'object', markdown: '<object data="x.swf"></object>', visible: '<object data="x.swf"></object>' },
  { name: 'embed', markdown: '<embed src="x.swf">', visible: '<embed src="x.swf">' },
  { name: 'math element', markdown: '<math><mi xlink:href="javascript:alert(1)">x</mi></math>', visible: '<math><mi' },
  { name: 'template element', markdown: '<template><script>alert(1)</script></template>', visible: '<template>' },
  { name: 'noscript element', markdown: '<noscript><p title="</noscript><img src=x onerror=alert(1)>">', visible: '<noscript>' },
  {
    name: 'div onclick',
    markdown: '<div onclick="alert(1)">click</div>',
    visible: '<div onclick="alert(1)">click</div>',
  },
  { name: 'body onload', markdown: '<body onload=alert(1)>', visible: '<body onload=alert(1)>' },
  {
    name: 'style element',
    markdown: '<style>body{background:url(javascript:alert(1))}</style>',
    visible: '<style>body{background:url(javascript:alert(1))}</style>',
  },
  {
    name: 'style attribute',
    markdown: '<p style="background:url(javascript:alert(1))">x</p>',
    visible: '<p style="background:url(javascript:alert(1))">x</p>',
  },
  {
    name: 'meta refresh',
    markdown: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    visible: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  },
  {
    name: 'base element',
    markdown: '<base href="javascript:alert(1)//">',
    visible: '<base href="javascript:alert(1)//">',
  },
  {
    name: 'form action',
    markdown: '<form action="javascript:alert(1)"><input type=submit></form>',
    visible: '<form action="javascript:alert(1)"><input type=submit></form>',
  },
  {
    name: 'link title attribute breakout',
    markdown: '[a](http://example.com "x\\" onmouseover=\\"alert(1)")',
    visible: 'a',
  },
  {
    name: 'fence info string breakout',
    markdown: '```"><script>alert(1)</script>\ncode\n```',
    visible: 'code',
  },
  {
    name: 'table cell script',
    markdown: '| h |\n| - |\n| <script>alert(1)</script> |',
    visible: '<script>alert(1)</script>',
  },
  {
    name: 'html comment breakout',
    markdown: '<!-- --><script>alert(1)</script>',
    visible: '<!-- --><script>alert(1)</script>',
  },
  { name: 'unterminated script', markdown: '<script>alert(1)', visible: '<script>alert(1)' },
];

const CSP_META_CONTENT =
  "default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

describe('markdown to HTML security', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('detects dangerous constructs in known-bad HTML (oracle self-check)', () => {
    const bad =
      '<p><a href="java&#x09;script:alert(1)">a</a><img src=x onerror=alert(1)><svg onload=alert(1)></svg>' +
      '<iframe srcdoc="x"></iframe><a href="data:text/html,x">d</a><a href="ftp://example.com/x">f</a>' +
      '<p style="background:url(x)">s</p><math></math><template></template><noscript></noscript></p>';
    const found = findDangerousConstructs(bad).map((v) => `${v.kind}:${v.detail.split('=')[0]}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'url:a[href]',
        'event-handler:img[onerror]',
        'event-handler:svg[onload]',
        'element:<iframe>',
        'element:iframe[srcdoc]',
        'url:p[style]',
        'element:<math>',
        'element:<template>',
        'element:<noscript>',
      ])
    );
    expect(findDangerousConstructs(bad).filter((v) => v.kind === 'url' && v.detail.startsWith('a['))).toHaveLength(3);
    expect(findDangerousConstructs('<p><img src="data:image/png;base64,AAAA"></p>')).toEqual([]);
    expect(findDangerousConstructs('<p><img src="data:image/svg+xml;base64,AAAA"></p>')).not.toEqual([]);
    expect(findDangerousConstructs('<p><a href="https://example.com/a?b=1&amp;c=2">x</a></p>')).toEqual([]);
  });

  it.each(XSS_VECTORS)('neutralizes $name and keeps it readable', async ({ markdown, visible }) => {
    const html = await mdToHtml(markdown);
    expect(findDangerousConstructs(html)).toEqual([]);
    const body = collectBodyText(html);
    expect(body.trim()).not.toBe('');
    expect(body).toContain(visible);
  });

  it('keeps an attribute-breakout image alt as inert attribute text', async () => {
    const html = await mdToHtml('![x" onerror="alert(1)](http://example.com/a.png)');
    expect(findDangerousConstructs(html)).toEqual([]);
    expect(collectAttributes(html, new Set(['alt']))).toEqual([['img', 'alt', 'x" onerror="alert(1)']]);
  });

  it('escapes raw HTML so the source text stays visible instead of executing', async () => {
    const html = await mdToHtml('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    const text = collectText(html);
    expect(text).toContain('<script>alert(1)</script>');
    expect(text).toContain('<img src=x onerror=alert(1)>');
    expect(findDangerousConstructs(html)).toEqual([]);
  });

  it('keeps safe link and image destinations', async () => {
    const html = await mdToHtml(
      '[web](https://example.com/a?b=1&c=2) [mail](mailto:a@example.com) [rel](docs/page.md) [frag](#top)\n\n' +
        '![pic](data:image/png;base64,iVBORw0KGgo=) ![remote](https://example.com/p.png "t")'
    );
    const urls = collectAttributes(html, new Set(['href', 'src'])).map(([tag, , value]) => `${tag}:${value}`);
    expect(urls).toEqual([
      'a:https://example.com/a?b=1&c=2',
      'a:mailto:a@example.com',
      'a:docs/page.md',
      'a:#top',
      'img:data:image/png;base64,iVBORw0KGgo=',
      'img:https://example.com/p.png',
    ]);
  });

  it('drops a destination that is valid for only the other element kind and keeps the element inert', async () => {
    const html = await mdToHtml('[pic link](data:image/png;base64,iVBORw0KGgo=) ![mail image](mailto:a@example.com)');
    expect(collectAttributes(html, new Set(['href', 'src']))).toEqual([]);
    expect(collectAttributes(html, new Set(['alt']))).toEqual([['img', 'alt', 'mail image']]);
    expect(collectBodyText(html)).toContain('pic link');
    expect(findDangerousConstructs(html)).toEqual([]);
  });

  it('does not let a crafted file name break out of the document title', async () => {
    const html = await mdToHtml('# ok', 'x</title><script>alert(1)</script>.md');
    expect(findDangerousConstructs(html)).toEqual([]);
    expect(collectText(html)).toContain('x</title><script>alert(1)</script>');
  });

  it('ships a restrictive Content-Security-Policy in the generated page', async () => {
    const html = await mdToHtml('# ok');
    const meta = collectAttributes(html, new Set(['http-equiv', 'content']));
    expect(meta).toEqual([
      ['meta', 'http-equiv', 'Content-Security-Policy'],
      ['meta', 'content', CSP_META_CONTENT],
    ]);
  });

  it('renders CommonMark structure that the previous regex converter could not', async () => {
    const html = await mdToHtml(
      '- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```js\nconst a = 1 < 2;\n```\n\n~~gone~~\n\n| h1 | h2 |\n| -- | :-: |\n| a | b |\n'
    );
    const body = html.slice(html.indexOf('<body>'));
    expect(body).toContain('<ul>\n<li>one</li>\n<li>two</li>\n</ul>');
    expect(body).toContain('<ol>\n<li>first</li>\n<li>second</li>\n</ol>');
    expect(body).toContain('<blockquote>\n<p>quoted</p>\n</blockquote>');
    expect(body).toContain('<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>');
    expect(body).toContain('<s>gone</s>');
    expect(body).toContain('<table>');
    expect(body).toContain('<th style="text-align:center">h2</th>');
    // The old converter wrapped everything in a single <p>, producing <p><h1>...</h1></p>; that is
    // visible only in the raw serialization because an HTML parser silently repairs it.
    expect(body).not.toMatch(/<p>\s*<(h[1-6]|ul|ol|table|pre|blockquote)\b/);
  });

  describe('fence language', () => {
    const classes = (html: string) => collectAttributes(html, new Set(['class'])).map(([, , value]) => value);

    it('keeps a plain language as a class', () => {
      expect(classes(renderMarkdownFragment('```ts\nx\n```'))).toEqual(['language-ts']);
    });

    it('drops a language containing markup or quote characters but keeps the code', () => {
      for (const info of ['"onload=x', "'><b>", 'a=b', 'x`y']) {
        const html = renderMarkdownFragment('```' + info + '\ncode\n```');
        expect(classes(html), info).toEqual([]);
        expect(collectBodyText(html), info).toContain('code');
      }
    });

    it('drops an over-long language', () => {
      expect(classes(renderMarkdownFragment('```' + 'a'.repeat(65) + '\ncode\n```'))).toEqual([]);
      expect(classes(renderMarkdownFragment('```' + 'a'.repeat(64) + '\ncode\n```'))).toEqual([`language-${'a'.repeat(64)}`]);
    });

    it('validates the unescaped info string, as the renderer uses it', () => {
      expect(classes(renderMarkdownFragment('``` foo\\+bar\ncode\n```'))).toEqual(['language-foo+bar']);
      expect(classes(renderMarkdownFragment('``` x&quot;y\ncode\n```'))).toEqual([]);
    });
  });
});

describe('markdown resource budgets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const bombSource = (urlLength: number, uses: number, definition: (url: string) => string, use: string): string =>
    `${definition('http://x/' + 'a'.repeat(urlLength))}\n\n${use.repeat(uses)}`;

  it('rejects a reference destination reused many times before building the output', () => {
    // 100 uses of a 200,000 character destination would otherwise produce about 20 MB of attributes.
    const source = bombSource(200_000, 100, (url) => `[r]: ${url}`, '[r] ');
    expect(source.length).toBeLessThan(MAX_MARKDOWN_SOURCE_CHARS);
    expect(() => renderMarkdownFragment(source)).toThrow(MarkdownSanitizationError);
  }, 5000);

  it('rejects the same amplification through titles and images', () => {
    const title = bombSource(200_000, 100, (url) => `[r]: /u "${url}"`, '[r] ');
    const image = bombSource(200_000, 100, (url) => `[r]: ${url}`, '![r] ');
    expect(() => renderMarkdownFragment(title)).toThrow(/attribute values exceed/);
    expect(() => renderMarkdownFragment(image)).toThrow(/attribute values exceed/);
  }, 5000);

  it('fails as a typed conversion error through the public converter', async () => {
    const source = bombSource(200_000, 100, (url) => `[r]: ${url}`, '[r] ');
    const error = await convertFile(Buffer.from(source), 'md', 'html', {}, 'bomb.md').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).name).toBe('MarkdownSanitizationError');
    expect((error as Error).message).toBe(
      `Markdown attribute values exceed the ${MAX_MARKDOWN_ATTRIBUTE_CHARS} character limit`
    );
  }, 5000);

  it('still renders many uses of a short shared reference', () => {
    const html = renderMarkdownFragment(bombSource(10, 3000, (url) => `[r]: ${url}`, '[r] '));
    const hrefs = collectAttributes(html, new Set(['href']));
    expect(hrefs).toHaveLength(3000);
    expect(new Set(hrefs.map(([, , value]) => value))).toEqual(new Set([`http://x/${'a'.repeat(10)}`]));
  });

  it('rejects a source above the size limit and accepts one at the limit', () => {
    expect(() => renderMarkdownFragment('a'.repeat(MAX_MARKDOWN_SOURCE_CHARS + 1))).toThrow(/character limit/);
    const html = renderMarkdownFragment('a'.repeat(MAX_MARKDOWN_SOURCE_CHARS));
    expect(html.length).toBe(MAX_MARKDOWN_SOURCE_CHARS + '<p></p>\n'.length);
  });

  it('rejects non-string input with the typed error', () => {
    expect(() => renderMarkdownFragment(42 as unknown as string)).toThrow(MarkdownSanitizationError);
  });

  it('rejects too many block tokens while block parsing is running', () => {
    // Each "#" heading is three tokens.
    const headings = Math.ceil(MAX_MARKDOWN_BLOCK_TOKENS / 3) + 10;
    const source = '#\n'.repeat(headings);
    expect(source.length).toBeLessThan(MAX_MARKDOWN_SOURCE_CHARS);
    expect(() => renderMarkdownFragment(source)).toThrow(/block token limit/);
  });

  it('rejects too many inline tokens', () => {
    // Two inline tokens per line (text and hard break) inside one paragraph.
    const lines = Math.ceil(MAX_MARKDOWN_TOTAL_TOKENS / 2) + 10;
    const source = 'a  \n'.repeat(lines);
    expect(source.length).toBeLessThan(MAX_MARKDOWN_SOURCE_CHARS);
    expect(() => renderMarkdownFragment(source)).toThrow(/token limit/);
  });

  it('turns a resource-exhaustion RangeError into the typed error', () => {
    vi.spyOn(MarkdownIt.prototype, 'render').mockImplementation(() => {
      throw new RangeError('Invalid string length');
    });
    expect(() => renderMarkdownFragment('# hi')).toThrow(MarkdownSanitizationError);
    expect(() => renderMarkdownFragment('# hi')).toThrow(/Invalid string length/);
  });

  it('does not convert unrelated errors', () => {
    vi.spyOn(MarkdownIt.prototype, 'render').mockImplementation(() => {
      throw new TypeError('unrelated');
    });
    expect(() => renderMarkdownFragment('# hi')).toThrow(TypeError);
  });

  it('keeps the attribute budget larger than any single legitimate destination', () => {
    const url = 'a'.repeat(100_000);
    expect(MAX_MARKDOWN_ATTRIBUTE_CHARS).toBeGreaterThan(url.length * 10);
    expect(renderMarkdownFragment(`[x](/${url})`)).toContain(`href="/${url}"`);
  });
});

describe('markdown token policy', () => {
  // Token streams are built by a separately configured parser (raw HTML enabled) to reach branches the
  // production parser never produces.
  const permissive = new MarkdownIt('commonmark', { html: true }).enable(['table']);

  it('rejects raw HTML tokens', () => {
    expect(() => applyTokenPolicy(permissive.parse('<div>x</div>', {}))).toThrow(/raw HTML token \(html_block\)/);
    expect(() => applyTokenPolicy(permissive.parse('a <b>x</b>', {}))).toThrow(/raw HTML token \(html_inline\)/);
  });

  it('rejects an element outside the allowlist', () => {
    const tokens = permissive.parse('text', {});
    tokens[0].tag = 'script';
    expect(() => applyTokenPolicy(tokens)).toThrow(/non-allowlisted element <script>/);
  });

  it('rejects an attribute outside the per-element allowlist', () => {
    const tokens = permissive.parse('text', {});
    tokens[0].attrSet('onclick', 'alert(1)');
    expect(() => applyTokenPolicy(tokens)).toThrow(/non-allowlisted attribute p\[onclick\]/);
  });

  it('drops an unsafe destination from a link token without failing', () => {
    const tokens = permissive.parse('[a](https://example.com)', {});
    const link = tokens[1].children?.find((t) => t.type === 'link_open');
    expect(link?.attrGet('href')).toBe('https://example.com');
    link?.attrSet('href', 'javascript:alert(1)');
    applyTokenPolicy(tokens);
    expect(link?.attrs).toEqual([]);
  });

  it('drops an unusable table alignment style and list start', () => {
    const table = permissive.parse('| a |\n| :- |\n| b |', {});
    const cell = table.find((t) => t.type === 'th_open');
    expect(cell?.attrGet('style')).toBe('text-align:left');
    cell?.attrSet('style', 'background:url(x)');
    const list = permissive.parse('3. x', {});
    list[0].attrSet('start', '3; drop');
    applyTokenPolicy(table);
    applyTokenPolicy(list);
    expect(cell?.attrs).toEqual([]);
    expect(list[0].attrs).toEqual([]);
  });

  it('reports the typed conversion error class', () => {
    try {
      applyTokenPolicy(permissive.parse('<div>x</div>', {}));
      expect.unreachable('policy must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownSanitizationError);
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).name).toBe('MarkdownSanitizationError');
    }
  });
});
