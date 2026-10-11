import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { markdownToSafeHtml } from '../src/lib/conversions/markdown-pdf';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool, type ExternalOracleTool } from './helpers/differential-oracle';

/**
 * HTML bound for LibreOffice is rebuilt from the parsed tree instead of being passed on as raw
 * bytes, so markup only LibreOffice would see (control characters inside names, abrupt comments,
 * raw-text elements it parses as markup, CSS escapes it reads differently, SVG inside data: images)
 * can no longer make it open a local file or keep a script link. Real LibreOffice is the subject of
 * the end-to-end cases; pdfimages, pdftotext and an independent PDF parser (pdf-lib) are the oracles.
 */

const LIBREOFFICE_TIMEOUT_MS = 180_000;
const LIBREOFFICE_TOOLS: ExternalOracleTool[] = ['soffice', 'pdfimages', 'pdftotext'];
const NATIVE_ENGINE = /^native-soffice/;
const STAGED_PREFIX = '<html><head><meta charset="utf-8"></head><body>';
const STAGED_SUFFIX = '</body></html>';

function poppler(tool: ExternalOracleTool, args: string[], pdf: Buffer): string {
  const binary = requireOracleTool(tool);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-oracle-'));
  const file = path.join(dir, 'input.pdf');
  try {
    fs.writeFileSync(file, pdf);
    const trailing = tool === 'pdftotext' ? [file, '-'] : [file];
    return execFileSync(binary, [...args, ...trailing], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Number of images embedded in the PDF, from the pdfimages listing (two header lines). */
function embeddedImageCount(pdf: Buffer): number {
  return poppler('pdfimages', ['-list'], pdf)
    .split('\n')
    .slice(2)
    .filter((line) => line.trim().length > 0).length;
}

function normalizedText(pdf: Buffer): string {
  return poppler('pdftotext', ['-q'], pdf).replace(/\s+/g, ' ').trim();
}

/** URI actions of every link annotation, read with pdf-lib. */
async function linkTargets(pdfBytes: Buffer): Promise<string[]> {
  const pdf = await PDFDocument.load(pdfBytes);
  const uris: string[] = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const action = annots.lookup(i, PDFDict).lookupMaybe(PDFName.of('A'), PDFDict);
      const uri = action?.lookupMaybe(PDFName.of('URI'), PDFString);
      if (uri) uris.push(uri.decodeText());
    }
  }
  return uris;
}

function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
}

/** A stand-in LibreOffice that records that it ran, then fails. */
function recordingSoffice(): { binary: string; invoked: () => boolean } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-soffice-'));
  const marker = path.join(dir, 'invoked');
  const binary = path.join(dir, 'soffice');
  fs.writeFileSync(binary, `#!/bin/sh\ncase "$*" in *--help*) exit 0;; esac\ntouch '${marker}'\nexit 3\n`, { mode: 0o755 });
  return { binary, invoked: () => fs.existsSync(marker) };
}

async function withSoffice<T>(binary: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.SOFFICE_PATH;
  process.env.SOFFICE_PATH = binary;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.SOFFICE_PATH;
    else process.env.SOFFICE_PATH = previous;
  }
}

/** Stages HTML and returns the staged document. */
async function stage(html: string): Promise<string> {
  return (await stageHtmlForNativeEngine(html)).html;
}

function errorOutcome(error: unknown): { name?: string; message: string } {
  return { name: (error as Error | undefined)?.name, message: (error as Error | undefined)?.message ?? '' };
}

function convertHtml(html: string): Promise<{ value?: Awaited<ReturnType<typeof executeWorkerConversion>>; error?: unknown }> {
  return settle(executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'payload.html'));
}

/** Code points some CSS readers skip inside or around names, so `u<c>rl(` or `<c>url(` still reads as url(. */
const IGNORABLE_CODE_POINTS = [
  0x85, 0xa0, 0xad, 0x34f, 0x61c, 0x115f, 0x180e, 0x2000, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029,
  0x202f, 0x205f, 0x2060, 0x2061, 0x3000, 0x3164, 0xfeff, 0xfff9, 0xfffd, 0xe0001, 0x1d173,
];

/** Legacy character references without a semicolon, decoded in text and kept before '=' or a letter in attributes. */
const ENTITY_HTML =
  '<p>Caf&eacute; &copy 2025 &amp more &notit &AMP; end&nbsp;x ' +
  '<a href="https://example.com/?a=1&copy=2&amp=3&nbspx&amp;b=4">link</a></p>';
const ENTITY_TEXT = 'Caf\u00e9 \u00a9 2025 & more \u00acit & end x link';
const ENTITY_LINK = 'https://example.com/?a=1&copy=2&amp=3&nbspx&b=4';

/** A PNG signature followed by bytes that are no PNG. */
const FAKE_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not an image at all')]).toString('base64');

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-fixture-'));
const LOCAL_IMAGE = path.join(fixtureDir, 'local.png');
const LOCAL_URL = `file://${LOCAL_IMAGE}`;
/** An SVG that draws the local image; LibreOffice's SVG importer would load it. */
const SVG_WITH_LOCAL_IMAGE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="80" height="80">' +
    `<image xlink:href="${LOCAL_URL}" width="80" height="80"/></svg>`
).toString('base64');

describe('HTML bound for LibreOffice is rebuilt from the parsed tree', () => {
  let poolWasEnabled = false;
  let pngDataUri = '';

  beforeAll(async () => {
    // The pool daemon cannot start in some sandboxes; one-shot LibreOffice runs the same filter.
    poolWasEnabled = libreOfficePool.isEnabled();
    libreOfficePool.disable();
    const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 210, g: 30, b: 30 } } }).png().toBuffer();
    fs.writeFileSync(LOCAL_IMAGE, png);
    const small = await sharp({ create: { width: 12, height: 8, channels: 3, background: { r: 20, g: 40, b: 220 } } }).png().toBuffer();
    pngDataUri = `data:image/png;base64,${small.toString('base64')}`;
  });

  afterAll(() => {
    if (poolWasEnabled) libreOfficePool.enable();
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  const bypasses: Array<[string, string]> = [
    ['a NUL inside the src attribute name', `<p>nul name</p><img s\u0000rc="${LOCAL_URL}">`],
    ['a NUL inside the href attribute name of a script link', '<p><a hr\u0000ef="javascript:alert(1)">nul link</a></p>'],
    ['a control character inside a CSS function name', `<p style="background:ur\u0001l(${LOCAL_URL}); height:60px">control</p>`],
    ['a line feed inside a CSS function name', `<p style="background:ur\nl(${LOCAL_URL}); height:60px">line feed</p>`],
    ['a carriage return inside a CSS property name', `<p style="back\rground:url(${LOCAL_URL}); height:60px">return</p>`],
    ['a line feed inside a CSS string', `<p style="content:'\n'; background:url(${LOCAL_URL}); height:60px">string</p>`],
    ['an unterminated CSS string', `<p style="height:60px; content:'x; background:url(${LOCAL_URL})">open string</p>`],
    ['an abruptly closed empty comment', `<p>abrupt</p><!--><img src="${LOCAL_URL}"><!-- -->`],
    ['a three-dash comment', `<p>triple</p><!---><img src="${LOCAL_URL}"><!-- -->`],
    ['an image inside a textarea', `<p>textarea</p><textarea><img src="${LOCAL_URL}"></textarea>`],
    ['an image inside noframes', `<p>noframes</p><noframes><img src="${LOCAL_URL}"></noframes>`],
    ['a backslash before a CSS quote', `<p style='content:"\\"; background:url(${LOCAL_URL}); x:"'>escape</p>`],
    ['an SVG data: image that draws a local file', `<p>svg data</p><img src="data:image/svg+xml;base64,${SVG_WITH_LOCAL_IMAGE}">`],
    ['an SVG labelled as a PNG data: image', `<p>labelled</p><img src="data:image/png;base64,${SVG_WITH_LOCAL_IMAGE}">`],
  ];

  for (const [name, html] of bypasses) {
    oracleTest(
      `${name} neither embeds a local file nor keeps a script link`,
      LIBREOFFICE_TOOLS,
      async () => {
        const { value, error } = await convertHtml(html);
        if (error !== undefined) {
          // Refused before LibreOffice: a disallowed reference (400) or an element no engine renders (503).
          expect(['ConversionFailedError', 'EngineUnavailableError']).toContain((error as Error).name);
          return;
        }
        const pdf = value!.buffer;
        const links = await linkTargets(pdf);
        expect({
          engine: NATIVE_ENGINE.test(value!.engineUsed),
          images: embeddedImageCount(pdf),
          unsafeLinks: links.filter((uri) => /^\s*(?:javascript|file):/i.test(uri)),
          scriptInBytes: pdf.toString('latin1').toLowerCase().includes('javascript:'),
        }).toEqual({ engine: true, images: 0, unsafeLinks: [], scriptInBytes: false });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }

  // Some CSS readers swallow the character after U+FFFF or a code point whose low 16 bits are below 0x20,
  // which moves the closing quote: the url() below would then sit outside any string.
  for (const codePoint of [0xe0001, 0x10000, 0xffff]) {
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    oracleTest(
      `refuses a CSS string holding ${label} on the LibreOffice route`,
      LIBREOFFICE_TOOLS,
      async () => {
        const c = String.fromCodePoint(codePoint);
        const html = `<p style='height:60px; content:"${c}";a:"b;background:url(${LOCAL_URL});c"'>quote parity</p>`;
        const { value, error } = await convertHtml(html);
        expect({ name: errorOutcome(error).name, images: value ? embeddedImageCount(value.buffer) : 0 }).toEqual({
          name: 'ConversionFailedError',
          images: 0,
        });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }

  const nonAsciiCss: Array<[string, string]> = [
    ['U+200B before url(', `<p style="background:${String.fromCodePoint(0x200b)}url(${LOCAL_URL}); height:60px">zero width</p>`],
    ['U+E0001 inside url', `<p style="background:u${String.fromCodePoint(0xe0001)}rl(${LOCAL_URL}); height:60px">tag</p>`],
    ['U+3000 before url( in a style sheet', `<style>p { background:${String.fromCodePoint(0x3000)}url(${LOCAL_URL}); height:60px }</style><p>ideographic</p>`],
  ];
  for (const [name, html] of nonAsciiCss) {
    oracleTest(
      `refuses CSS with ${name} on the LibreOffice route`,
      LIBREOFFICE_TOOLS,
      async () => {
        const { value, error } = await convertHtml(html);
        expect({ name: errorOutcome(error).name, images: value ? embeddedImageCount(value.buffer) : 0 }).toEqual({
          name: 'ConversionFailedError',
          images: 0,
        });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  }

  oracleTest(
    'refuses a fake PNG data: image instead of letting LibreOffice drop it',
    LIBREOFFICE_TOOLS,
    async () => {
      const { value, error } = await convertHtml(`<p>fake image</p><img src="data:image/png;base64,${FAKE_PNG}">`);
      expect({ name: errorOutcome(error).name, images: value ? embeddedImageCount(value.buffer) : 0 }).toEqual({
        name: 'ConversionFailedError',
        images: 0,
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'decodes legacy character references through LibreOffice and keeps them in link targets',
    LIBREOFFICE_TOOLS,
    async () => {
      const { value, error } = await convertHtml(ENTITY_HTML);
      expect(error).toBeUndefined();
      expect({
        engine: NATIVE_ENGINE.test(value!.engineUsed),
        text: normalizedText(value!.buffer),
        links: (await linkTargets(value!.buffer)).filter((uri) => !uri.startsWith('#')),
      }).toEqual({ engine: true, text: ENTITY_TEXT, links: [ENTITY_LINK] });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'a plain document keeps its text, web link and embedded PNG through LibreOffice',
    LIBREOFFICE_TOOLS,
    async () => {
      const html =
        '<!DOCTYPE html><html><head><title>Plain</title><style>h1 { color: #224488 } td { padding: 4px }</style></head><body>' +
        '<h1>Quarterly notes</h1><p>See the <a href="https://example.com/docs?a=1&amp;b=2">docs link</a> and ' +
        '<a href="#totals">totals</a>.</p>' +
        `<p><img src="${pngDataUri}" alt="swatch" width="12" height="8"></p>` +
        '<table><tr><th>Item</th><th>Count</th></tr><tr><td>Apples &amp; pears</td><td>3</td></tr></table>' +
        '<ul><li>first point</li><li>second point</li></ul><h2 id="totals">Totals</h2></body></html>';
      const { value, error } = await convertHtml(html);
      expect(error).toBeUndefined();
      const pdf = value!.buffer;
      const text = normalizedText(pdf);
      const phrases = ['Quarterly notes', 'See the docs link and totals.', 'Item', 'Count', 'Apples & pears', 'first point', 'second point', 'Totals'];
      const positions = phrases.map((phrase) => text.indexOf(phrase));
      expect({
        engine: NATIVE_ENGINE.test(value!.engineUsed),
        inOrder: positions.every((position, i) => position >= 0 && (i === 0 || position > positions[i - 1])),
        images: embeddedImageCount(pdf),
        webLinks: (await linkTargets(pdf)).filter((uri) => !uri.startsWith('#')),
      }).toEqual({ engine: true, inOrder: true, images: 1, webLinks: ['https://example.com/docs?a=1&b=2'] });
    },
    LIBREOFFICE_TIMEOUT_MS
  );
});

describe('CSS checks before LibreOffice', () => {
  const refused: Array<[string, string]> = [
    ['an empty group inside image-set()', `<p style="background-image:image-set((), 'file:///etc/hosts' 1x)">group</p>`],
    ['a string inside image()', `<p style="background-image:image('file:///etc/hosts')">image</p>`],
    ['a string inside cross-fade()', `<p style="background-image:cross-fade(url(#a), 'http://192.0.2.2:18765/x.png', 50%)">fade</p>`],
    ['any backslash', '<p style="font-family:\\66 oo">escape</p>'],
    ['an SVG data: background', '<p style="background:url(data:image/svg+xml;base64,PHN2Zy8+)">svg</p>'],
    ['an import of embedded CSS', '<style>@import url("data:text/css;base64,cCB7IGNvbG9yOiByZWQgfQ==");</style><p>import</p>'],
    ['a character reference inside a style sheet', '<style>p { background: &#117;rl(file:///etc/hosts) }</style><p>reference</p>'],
    ['a "<" inside a style sheet', '<style>p { content: "<img src=x>" }</style><p>markup</p>'],
  ];
  for (const [name, html] of refused) {
    it(`refuses ${name} before LibreOffice runs`, async () => {
      const soffice = recordingSoffice();
      const { error } = await withSoffice(soffice.binary, () => convertHtml(html));
      expect({ name: (error as Error)?.name, invoked: soffice.invoked() }).toEqual({ name: 'ConversionFailedError', invoked: false });
    });
  }
});

describe('stageHtmlForNativeEngine', () => {
  it('escapes every text node and attribute value and drops C0 controls', async () => {
    const staged = await stage(
      '<p title="a&quot;b&lt;c&#39;d&gt;e&amp;f">x &lt;y&gt; &amp; "z" \'w\' a\u0001b\u0000c\u007fd\te&#1;f</p>'
    );
    expect(staged).toBe(
      `${STAGED_PREFIX}<p title="a&quot;b&lt;c&#39;d&gt;e&amp;f">x &lt;y&gt; &amp; &quot;z&quot; &#39;w&#39; abcd\tef</p>${STAGED_SUFFIX}`
    );
  });

  it('never emits comments, doctypes, processing instructions or attributes outside the allowlist', async () => {
    const staged = await stage(
      '<!DOCTYPE html><!-- note --><?xml-stylesheet href="x.css"?><![CDATA[ cdata ]]>' +
        '<p onclick="go()" data-src="x.png" class="lead" style="color: red /* c */">t</p>'
    );
    expect(staged).toBe(`${STAGED_PREFIX}<p class="lead" style="color: red  ">t</p>${STAGED_SUFFIX}`);
  });

  it('emits raw-text content as escaped text and drops script, template and frame fallbacks', async () => {
    const staged = await stage(
      '<title>A &lt;b&gt; title</title><xmp><b>bold</b></xmp>' +
        '<script>alert(1)</script><noscript><p>no script</p></noscript><template><p>tpl</p></template>' +
        '<noframes><p>frames</p></noframes><noembed><p>embed</p></noembed><iframe><p>frame</p></iframe><p>kept</p>'
    );
    expect(staged).toBe(
      '<html><head><meta charset="utf-8"><title>A &lt;b&gt; title</title></head><body>' +
        '<pre>&lt;b&gt;bold&lt;/b&gt;</pre><p>kept</p>' +
        STAGED_SUFFIX
    );
  });

  it('honours self-closing MathML children, so 300 of them are not 300 nesting levels', async () => {
    const staged = await stage(`<p>before</p><math>${'<mspace width="1em"/>'.repeat(300)}</math><p>after</p>`);
    expect(staged).toBe(`${STAGED_PREFIX}<p>before</p><p>after</p>${STAGED_SUFFIX}`);
  });

  it('refuses an inline SVG with 300 self-closed paths as unsupported, not as nested too deeply', async () => {
    const soffice = recordingSoffice();
    const html = `<p>before</p><svg>${'<path d="M0 0"/>'.repeat(300)}</svg><p>after</p>`;
    const { error } = await withSoffice(soffice.binary, () => convertHtml(html));
    expect({ name: (error as Error)?.name, nesting: /nests/.test(errorOutcome(error).message), invoked: soffice.invoked() }).toEqual({
      name: 'EngineUnavailableError',
      nesting: false,
      invoked: false,
    });
  });

  it('keeps web, mail and fragment links, and PNG, JPEG and GIF data images', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const jpegBytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: { r: 9, g: 99, b: 199 } } }).jpeg().toBuffer();
    const jpeg = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;
    const staged = await stage(
      `<a href=" HTTPS://example.com/a?b=1&amp;c=2 ">w</a><a href="mailto:x@example.com">m</a><a href="#t">f</a>` +
        `<img src="${png}" alt="p"><img src="${gif}"><img src="${jpeg}" width="2">`
    );
    expect(staged).toBe(
      `${STAGED_PREFIX}<a href="HTTPS://example.com/a?b=1&amp;c=2">w</a><a href="mailto:x@example.com">m</a><a href="#t">f</a>` +
        `<img src="${png}" alt="p"><img src="${gif}"><img src="${jpeg}" width="2">${STAGED_SUFFIX}`
    );
  });
});

describe('elements no engine renders', () => {
  it('refuses media, frames with content, SVG and form controls with EngineUnavailableError', async () => {
    const documents = [
      '<p>t</p><svg><rect width="4" height="4"/></svg>',
      '<p>t</p><video src="data:video/mp4;base64,AAAA"></video>',
      '<p>t</p><audio src="data:audio/mpeg;base64,AAAA"></audio>',
      '<p>t</p><canvas width="4" height="4"></canvas>',
      '<p>t</p><iframe srcdoc="&lt;p&gt;inner&lt;/p&gt;"></iframe>',
      '<p>t</p><object data="data:text/plain;base64,aGk="></object>',
      '<p>t</p><object><p>fallback</p></object>',
      '<p>t</p><embed src="data:text/plain;base64,aGk=">',
      '<p>t</p><select><option>a</option></select>',
      '<p>t</p><textarea>typed</textarea>',
      '<p>t</p><input type="text" value="typed">',
      '<frameset><frame src="data:text/html,x"></frameset>',
    ];
    const outcomes = await Promise.all(
      documents.map(async (html) => {
        const { error } = await settle(stage(html));
        return { html, name: errorOutcome(error).name, engine: (error as { engineName?: string } | undefined)?.engineName };
      })
    );
    expect(outcomes).toEqual(documents.map((html) => ({ html, name: 'EngineUnavailableError', engine: 'soffice' })));
  });

  it('drops only elements that render nothing', async () => {
    const staged = await stage(
      '<script>x()</script><noscript><p>n</p></noscript><template><p>t</p></template><iframe></iframe><object></object>' +
        '<input type="hidden" name="h" value="v"><p>kept</p>'
    );
    expect(staged).toBe(`${STAGED_PREFIX}<p>kept</p>${STAGED_SUFFIX}`);
  });
});

describe('CSS outside quoted strings is ASCII only', () => {
  for (const codePoint of IGNORABLE_CODE_POINTS) {
    const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    it(`refuses ${label} before, inside and after url in style attributes and sheets`, async () => {
      const c = String.fromCodePoint(codePoint);
      const declarations = [`background:${c}url(file:///etc/hosts)`, `background:u${c}rl(file:///etc/hosts)`, `background:url${c}(file:///etc/hosts)`];
      const documents = declarations.flatMap((declaration) => [`<p style="${declaration}">t</p>`, `<style>p { ${declaration} }</style><p>t</p>`]);
      const outcomes = await Promise.all(
        documents.map(async (html) => {
          const { error } = await settle(stage(html));
          return { html, name: errorOutcome(error).name, nonAscii: /non-ASCII/.test(errorOutcome(error).message) };
        })
      );
      expect(outcomes).toEqual(documents.map((html) => ({ html, name: 'ConversionFailedError', nonAscii: true })));
    });
  }

  const unprintable: Array<[string, string]> = [
    ['U+10000', String.fromCodePoint(0x10000)],
    ['U+20000', String.fromCodePoint(0x20000)],
    ['U+E0001', String.fromCodePoint(0xe0001)],
    ['U+F0000', String.fromCodePoint(0xf0000)],
    ['U+FFFF', String.fromCodePoint(0xffff)],
    ['U+1F600', String.fromCodePoint(0x1f600)],
    ['U+FDD0', String.fromCodePoint(0xfdd0)],
    ['a lone surrogate', String.fromCharCode(0xd800)],
  ];
  for (const [label, c] of unprintable) {
    it(`refuses ${label} inside a quoted CSS string`, async () => {
      const documents = [`<p style='content:"a${c}b"'>t</p>`, `<style>p { content: 'a${c}b' }</style><p>t</p>`];
      const outcomes = await Promise.all(
        documents.map(async (html) => {
          const { error } = await settle(stage(html));
          return { html, name: errorOutcome(error).name, printable: /printable Basic Multilingual Plane/.test(errorOutcome(error).message) };
        })
      );
      expect(outcomes).toEqual(documents.map((html) => ({ html, name: 'ConversionFailedError', printable: true })));
    });
  }

  it('keeps printable symbols inside quoted CSS strings', async () => {
    const symbols = '\u2192 \u00a9';
    const staged = await stage(`<p style='content:"${symbols}"; font-family:"Noto Sans CJK KR"'>t</p>`);
    expect(staged).toBe(`${STAGED_PREFIX}<p style="content:&quot;${symbols}&quot;; font-family:&quot;Noto Sans CJK KR&quot;">t</p>${STAGED_SUFFIX}`);
  });

  it('keeps non-ASCII text inside quoted CSS strings', async () => {
    const korean = '\ub9d1\uc740 \uace0\ub515';
    const japanese = '\u30d2\u30e9\u30ae\u30ce';
    const staged = await stage(
      `<style>p { font-family: "Noto Sans CJK KR", '${korean}' }</style><p style='font-family:"Noto Sans CJK JP", "${japanese}"'>t</p>`
    );
    expect(staged).toBe(
      `<html><head><meta charset="utf-8"><style>p { font-family: "Noto Sans CJK KR", '${korean}' }</style></head><body>` +
        `<p style="font-family:&quot;Noto Sans CJK JP&quot;, &quot;${japanese}&quot;">t</p>${STAGED_SUFFIX}`
    );
  });
});

describe('legacy character references', () => {
  it('decodes them in text, and in attributes only when no "=" or letter follows', async () => {
    const staged = await stage('<p title="&copy=1 &copyx &copy; &copy">&copy=1 &copyx &lt3 &AMP;</p>');
    expect(staged).toBe(`${STAGED_PREFIX}<p title="&amp;copy=1 &amp;copyx \u00a9 \u00a9">\u00a9=1 \u00a9x &lt;3 &amp;</p>${STAGED_SUFFIX}`);
  });

  oracleTest('decodes them on the in-process route and keeps them in link targets', ['pdftotext'], async () => {
    const result = await convertFile(Buffer.from(ENTITY_HTML, 'utf-8'), 'html', 'pdf', {}, 'entities.html');
    expect({ text: normalizedText(result.buffer), links: await linkTargets(result.buffer) }).toEqual({ text: ENTITY_TEXT, links: [ENTITY_LINK] });
  });
});

describe('embedded images bound for LibreOffice', () => {
  it('refuses data: images whose bytes do not decode as the declared format', async () => {
    const real = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const sources = [
      `data:image/png;base64,${FAKE_PNG}`,
      `data:image/png;base64,${real.subarray(0, Math.floor(real.length / 2)).toString('base64')}`,
      `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')}`,
      `data:image/gif;base64,${Buffer.from('GIF89a', 'latin1').toString('base64')}`,
    ];
    const documents = sources.flatMap((source) => [`<p>i</p><img src="${source}">`, `<p style="background:url(${source})">c</p>`]);
    const outcomes = await Promise.all(
      documents.map(async (html) => {
        const { error } = await settle(stage(html));
        return { html: html.slice(0, 60), name: errorOutcome(error).name };
      })
    );
    expect(outcomes).toEqual(documents.map((html) => ({ html: html.slice(0, 60), name: 'ConversionFailedError' })));
  });

  it('refuses a fake PNG from Markdown', async () => {
    const { error } = await settle(stage(markdownToSafeHtml(`![fake](data:image/png;base64,${FAKE_PNG})`, 'fake')));
    expect(errorOutcome(error).name).toBe('ConversionFailedError');
  });

  it('refuses an image above the pixel limit of the in-process renderer', async () => {
    const huge = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const { error } = await settle(stage(`<img src="data:image/png;base64,${huge.toString('base64')}">`));
    expect({ name: errorOutcome(error).name, pixels: /pixel/.test(errorOutcome(error).message) }).toEqual({ name: 'ConversionFailedError', pixels: true });
  });
});

describe('Markdown link labels', () => {
  oracleTest('renders an image inside a link label as the linked image text', ['pdftotext'], async () => {
    const result = await convertFile(Buffer.from('See [![build badge](badge.svg)](https://example.com/ci) now.\n', 'utf-8'), 'md', 'pdf', {}, 'badge.md');
    expect({ text: normalizedText(result.buffer), links: await linkTargets(result.buffer) }).toEqual({
      text: 'See build badge now.',
      links: ['https://example.com/ci'],
    });
  });
});
