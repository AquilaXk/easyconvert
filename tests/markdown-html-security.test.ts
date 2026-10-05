import { describe, it, expect } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { collectAttributes, collectText, findDangerousConstructs } from './helpers/html-dom-oracle';

async function mdToHtml(markdown: string, filename = 'doc.md'): Promise<string> {
  const result = await convertFile(Buffer.from(markdown, 'utf-8'), 'md', 'html', {}, filename);
  expect(result.mimeType).toBe('text/html');
  return result.buffer.toString('utf-8');
}

const XSS_VECTORS: Array<{ name: string; markdown: string }> = [
  { name: 'script block', markdown: '<script>alert(1)</script>' },
  { name: 'inline script', markdown: 'text <script>alert(1)</script> text' },
  { name: 'img onerror', markdown: '<img src=x onerror=alert(1)>' },
  { name: 'inline img onerror', markdown: 'before <img src=x onerror=alert(1)> after' },
  { name: 'javascript link', markdown: '[a](javascript:alert(1))' },
  { name: 'mixed-case javascript link', markdown: '[a](JaVaScRiPt:alert(1))' },
  { name: 'raw anchor with mixed-case scheme', markdown: '<a href="JaVaScRiPt:alert(1)">x</a>' },
  { name: 'decimal entity scheme', markdown: '[a](&#106;avascript:alert(1))' },
  { name: 'hex entity scheme', markdown: '[a](&#x6A;avascript:alert(1))' },
  { name: 'named entity colon', markdown: '[a](javascript&colon;alert(1))' },
  { name: 'raw anchor with entity scheme', markdown: '<a href="&#x6A;avascript:alert(1)">x</a>' },
  { name: 'raw anchor with entity colon', markdown: '<a href="javascript&colon;alert(1)">x</a>' },
  { name: 'control character inside scheme', markdown: '[a](<java\tscript:alert(1)>)' },
  { name: 'leading whitespace scheme', markdown: '[a](<  javascript:alert(1)>)' },
  { name: 'vbscript link', markdown: '[a](vbscript:msgbox(1))' },
  { name: 'data html link', markdown: '[a](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)' },
  { name: 'reference style javascript link', markdown: '[a][r]\n\n[r]: javascript:alert(1)' },
  { name: 'javascript autolink', markdown: '<javascript:alert(1)>' },
  { name: 'javascript image src', markdown: '![x](javascript:alert(1))' },
  { name: 'svg data image', markdown: '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)' },
  { name: 'svg onload', markdown: '<svg onload=alert(1)></svg>' },
  { name: 'svg slash onload', markdown: '<svg/onload=alert(1)>' },
  { name: 'svg with nested script', markdown: '<svg><script>alert(1)</script></svg>' },
  { name: 'iframe', markdown: '<iframe src="https://example.com"></iframe>' },
  { name: 'iframe javascript src', markdown: '<iframe src="javascript:alert(1)"></iframe>' },
  { name: 'object', markdown: '<object data="x.swf"></object>' },
  { name: 'embed', markdown: '<embed src="x.swf">' },
  { name: 'div onclick', markdown: '<div onclick="alert(1)">click</div>' },
  { name: 'body onload', markdown: '<body onload=alert(1)>' },
  { name: 'style element', markdown: '<style>body{background:url(javascript:alert(1))}</style>' },
  { name: 'meta refresh', markdown: '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">' },
  { name: 'base element', markdown: '<base href="javascript:alert(1)//">' },
  { name: 'form action', markdown: '<form action="javascript:alert(1)"><input type=submit></form>' },
  { name: 'link title attribute breakout', markdown: '[a](http://example.com "x\\" onmouseover=\\"alert(1)")' },
  { name: 'image alt attribute breakout', markdown: '![x" onerror="alert(1)](http://example.com/a.png)' },
  { name: 'fence info string breakout', markdown: '```"><script>alert(1)</script>\ncode\n```' },
  { name: 'table cell script', markdown: '| h |\n| - |\n| <script>alert(1)</script> |' },
  { name: 'html comment breakout', markdown: '<!-- --><script>alert(1)</script>' },
  { name: 'unterminated script', markdown: '<script>alert(1)' },
];

describe('markdown to HTML security', () => {
  it('detects dangerous constructs in known-bad HTML (oracle self-check)', () => {
    const bad =
      '<p><a href="java&#x09;script:alert(1)">a</a><img src=x onerror=alert(1)><svg onload=alert(1)></svg>' +
      '<iframe src="x"></iframe><a href="data:text/html,x">d</a></p>';
    const kinds = findDangerousConstructs(bad).map((v) => v.kind);
    expect(kinds.filter((k) => k === 'url')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'event-handler')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'element')).toHaveLength(1);
    expect(findDangerousConstructs('<p><img src="data:image/png;base64,AAAA"></p>')).toEqual([]);
  });

  it.each(XSS_VECTORS)('neutralizes $name', async ({ markdown }) => {
    const html = await mdToHtml(markdown);
    expect(findDangerousConstructs(html)).toEqual([]);
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

  it('does not let a crafted file name break out of the document title', async () => {
    const html = await mdToHtml('# ok', 'x</title><script>alert(1)</script>.md');
    expect(findDangerousConstructs(html)).toEqual([]);
    expect(collectText(html)).toContain('x</title><script>alert(1)</script>');
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
    // The old converter wrapped everything in a single <p>, producing <p><h1>...</h1></p>.
    expect(body).not.toMatch(/<p>\s*<(h[1-6]|ul|ol|table|pre|blockquote)\b/);
  });
});
