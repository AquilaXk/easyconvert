import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions/index';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
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

function convertHtml(html: string): Promise<{ value?: Awaited<ReturnType<typeof executeWorkerConversion>>; error?: unknown }> {
  return settle(executeWorkerConversion(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'payload.html'));
}

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
          expect((error as Error).name).toBe('ConversionFailedError');
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
  it('escapes every text node and attribute value and drops C0 controls', () => {
    const staged = stageHtmlForNativeEngine(
      '<p title="a&quot;b&lt;c&#39;d&gt;e&amp;f">x &lt;y&gt; &amp; "z" \'w\' a\u0001b\u0000c\u007fd\te&#1;f</p>'
    );
    expect(staged).toBe(
      `${STAGED_PREFIX}<p title="a&quot;b&lt;c&#39;d&gt;e&amp;f">x &lt;y&gt; &amp; &quot;z&quot; &#39;w&#39; abcd\tef</p>${STAGED_SUFFIX}`
    );
  });

  it('never emits comments, doctypes, processing instructions or attributes outside the allowlist', () => {
    const staged = stageHtmlForNativeEngine(
      '<!DOCTYPE html><!-- note --><?xml-stylesheet href="x.css"?><![CDATA[ cdata ]]>' +
        '<p onclick="go()" data-src="x.png" class="lead" style="color: red /* c */">t</p>'
    );
    expect(staged).toBe(`${STAGED_PREFIX}<p class="lead" style="color: red  ">t</p>${STAGED_SUFFIX}`);
  });

  it('emits raw-text content as escaped text and drops script, template and frame fallbacks', () => {
    const staged = stageHtmlForNativeEngine(
      '<title>A &lt;b&gt; title</title><textarea><img src="x.png"></textarea><xmp><b>bold</b></xmp>' +
        '<script>alert(1)</script><noscript><p>no script</p></noscript><template><p>tpl</p></template>' +
        '<noframes><p>frames</p></noframes><noembed><p>embed</p></noembed><iframe><p>frame</p></iframe><p>kept</p>'
    );
    expect(staged).toBe(
      '<html><head><meta charset="utf-8"><title>A &lt;b&gt; title</title></head><body>' +
        '<pre>&lt;img src=&quot;x.png&quot;&gt;</pre><pre>&lt;b&gt;bold&lt;/b&gt;</pre><p>kept</p>' +
        STAGED_SUFFIX
    );
  });

  it('honours self-closing SVG children, so 300 paths are not 300 nesting levels', () => {
    const staged = stageHtmlForNativeEngine(`<p>before</p><svg>${'<path d="M0 0"/>'.repeat(300)}</svg><p>after</p>`);
    expect(staged).toBe(`${STAGED_PREFIX}<p>before</p><p>after</p>${STAGED_SUFFIX}`);
  });

  it('sends an inline SVG with 300 self-closed paths on to LibreOffice', async () => {
    const soffice = recordingSoffice();
    const html = `<p>before</p><svg>${'<path d="M0 0"/>'.repeat(300)}</svg><p>after</p>`;
    const { error } = await withSoffice(soffice.binary, () => convertHtml(html));
    // The stand-in fails and the in-process renderer cannot draw SVG: LibreOffice was the engine tried.
    expect({ name: (error as Error)?.name, invoked: soffice.invoked() }).toEqual({ name: 'EngineUnavailableError', invoked: true });
  });

  it('keeps web, mail and fragment links, and PNG, JPEG and GIF data images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]).toString('base64')}`;
    const staged = stageHtmlForNativeEngine(
      `<a href=" HTTPS://example.com/a?b=1&amp;c=2 ">w</a><a href="mailto:x@example.com">m</a><a href="#t">f</a>` +
        `<img src="${png}" alt="p"><img src="${gif}"><img src="${jpeg}" width="2">`
    );
    expect(staged).toBe(
      `${STAGED_PREFIX}<a href="HTTPS://example.com/a?b=1&amp;c=2">w</a><a href="mailto:x@example.com">m</a><a href="#t">f</a>` +
        `<img src="${png}" alt="p"><img src="${gif}"><img src="${jpeg}" width="2">${STAGED_SUFFIX}`
    );
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
