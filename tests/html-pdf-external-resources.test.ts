import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { overrideImageFetchRules } from '../src/lib/conversions/html-image-fetch';
import { MAX_NAMED_REFERENCES } from '../src/lib/conversions/html-omitted-resources';
import { ConversionFailedError } from '../src/lib/types';
import { executeWorkerConversion, libreOfficePool } from '../src/worker/engines';
import { pdfFacts } from './helpers/corpus-facts';
import { oracleTest } from './helpers/oracle-test';
import { pdfImageCount, pdfLinkTargets, withCapturingSoffice } from './helpers/html-pdf-oracle';
import { solidPng, startImageServer, type ImageServer } from './helpers/image-server';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * An HTML page that names things the PDF cannot carry (relative links, style sheets, scripts, form controls, frames, CSS
 * pictures) is still converted: what the page names is left out and reported in one warning each, and nothing is fetched
 * for it. Images keep the guarded loader of docs/policy-decisions.md entry 6. LibreOffice is the renderer; pdftotext and
 * pdfinfo (through pdfFacts), pdfimages and pdf-lib's link annotations are the independent readers of its PDF, and
 * the first group converts real pages of the public real-world corpus.
 */

const LIBREOFFICE_TIMEOUT_MS = 180_000;
const TOOLS: Array<'soffice' | 'pdftotext' | 'pdfinfo' | 'pdfimages'> = ['soffice', 'pdftotext', 'pdfinfo', 'pdfimages'];
const NATIVE_ENGINE = /^native-soffice/;
const IMAGES_OFF = 'loading images is turned off on this server';

const ELEMENTS_WARNING = (count: number, listing: string): string => `Left out elements that cannot be drawn (${count}): ${listing}.`;
const REFERENCES_WARNING = (count: number, listing: string): string => `Left out references that are not loaded or followed (${count}): ${listing}.`;

let poolWasEnabled = false;

beforeAll(() => {
  // The pool daemon cannot start in some sandboxes; one-shot LibreOffice runs the same filter.
  poolWasEnabled = libreOfficePool.isEnabled();
  libreOfficePool.disable();
});

afterAll(() => {
  if (poolWasEnabled) libreOfficePool.enable();
});

function convert(html: string | Buffer, options: Record<string, unknown> = {}): ReturnType<typeof executeWorkerConversion> {
  return executeWorkerConversion(Buffer.isBuffer(html) ? html : Buffer.from(html, 'utf-8'), 'html', 'pdf', options, 'page.html');
}

/** The document LibreOffice is handed for this page. */
function handedToLibreOffice(html: string): Promise<string> {
  return withCapturingSoffice(() => convert(html));
}

function warningsOf(result: Awaited<ReturnType<typeof convert>>): string[] {
  return (result.metadata?.warnings ?? []) as string[];
}

describe('real pages of the public corpus', () => {
  let imageFetch: string | undefined;

  beforeEach(() => {
    // The pages name live hosts; nothing in these tests may reach them.
    imageFetch = process.env.HTML_IMAGE_FETCH;
    process.env.HTML_IMAGE_FETCH = 'off';
  });

  afterEach(() => {
    if (imageFetch === undefined) delete process.env.HTML_IMAGE_FETCH;
    else process.env.HTML_IMAGE_FETCH = imageFetch;
  });

  oracleTest(
    'converts a page that is only a frameset to a valid PDF and reports the frameset',
    TOOLS,
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-001782.html');
      const result = await convert(bytes);
      const facts = pdfFacts(result.buffer);
      expect({ native: NATIVE_ENGINE.test(result.engineUsed), pages: facts.pages, text: facts.text, warnings: warningsOf(result) }).toEqual({
        native: true,
        pages: 1,
        text: '',
        warnings: [ELEMENTS_WARNING(1, '<frameset> x 1')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'converts a page with a Flash object and a relative link, keeping its text and reporting both',
    TOOLS,
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000814.html');
      const result = await convert(bytes);
      const text = pdfFacts(result.buffer).text;
      expect({
        native: NATIVE_ENGINE.test(result.engineUsed),
        text: ['Script of animation', 'Is the Earth unique?', 'Back to Astro-Venture Home'].map((phrase) => text.includes(phrase)),
        links: (await pdfLinkTargets(result.buffer)).filter((uri) => !uri.startsWith('#')),
        warnings: warningsOf(result),
      }).toEqual({
        native: true,
        text: [true, true, true],
        links: [],
        warnings: [ELEMENTS_WARNING(1, '<object> x 1'), REFERENCES_WARNING(1, '"avhome.html" (<a href>)')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'converts a page with a Java applet and keeps its absolute http and mail links',
    TOOLS,
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000425.html');
      const result = await convert(bytes);
      const text = pdfFacts(result.buffer).text;
      expect({
        text: ['Hurricane IR Loop', 'Maintained by NESDIS Satellite Services Division'].map((phrase) => text.includes(phrase)),
        appletFallbackDrawn: text.includes('Java must be enabled'),
        links: (await pdfLinkTargets(result.buffer)).map((uri) => uri.toLowerCase()).sort(),
        warnings: warningsOf(result),
      }).toEqual({
        text: [true, true],
        appletFallbackDrawn: false,
        links: ['http://www.orbit.nesdis.noaa.gov/smcd/opdb/aviation/imgs.html', 'mailto:goeswebmaster@noaa.gov'],
        warnings: [ELEMENTS_WARNING(1, '<applet> x 1')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'converts a page with a background picture and images whose hosts are not loaded, and reports each',
    TOOLS,
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'govdocs1-000414.html');
      const result = await convert(bytes);
      expect({
        text: pdfFacts(result.buffer).text.includes('Senate Years of Service: 1929-1935'),
        images: pdfImageCount(result.buffer),
        warnings: warningsOf(result),
      }).toEqual({
        text: true,
        images: 0,
        warnings: [
          `Left out the image "http://bioguide.congress.gov/bioguide/navbar/navbio_new.jpg": ${IMAGES_OFF}.`,
          'Left out the image "//bioguide.congress.gov/bioguide/photo/H/H000436.jpg": only absolute http and https images are loaded.',
          REFERENCES_WARNING(1, '"http://bioguide.congress.gov/bioguide/paper1.gif" (background)'),
        ],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );
});

describe('references the PDF cannot carry', () => {
  const LINKS_PAGE =
    '<html><head><title>Notes</title><link rel="stylesheet" href="style.css"><link rel="icon" href="favicon.ico"><script src="app.js"></script></head>' +
    '<body background="bg.gif"><h1>Quarterly notes</h1><p>See <a href="other.html">relative</a>, <a href="../../etc/passwd">traversal</a>, ' +
    '<a href="file:///etc/hosts">file</a>, <a href="javascript:alert(1)">script</a>, <a href="ftp://example.com/x">ftp</a>, ' +
    '<a href="https://example.com/docs">kept</a>, <a href="mailto:a@example.com">mail</a> and <a href="#end">end</a>.</p><h2 id="end">End</h2></body></html>';

  oracleTest(
    'drops relative, file, javascript and ftp links, a style sheet and a background, keeping the text and the http and mail links',
    TOOLS,
    async () => {
      const result = await convert(LINKS_PAGE);
      const facts = pdfFacts(result.buffer);
      expect({
        native: NATIVE_ENGINE.test(result.engineUsed),
        pages: facts.pages,
        text: facts.text.includes('Quarterly notes See relative, traversal, file, script, ftp, kept, mail and end.'),
        links: (await pdfLinkTargets(result.buffer)).sort(),
        warnings: warningsOf(result),
      }).toEqual({
        native: true,
        pages: 1,
        text: true,
        links: ['https://example.com/docs', 'mailto:a@example.com'],
        warnings: [
          REFERENCES_WARNING(
            7,
            '"style.css" (<link href>), "bg.gif" (background), "other.html" (<a href>), "../../etc/passwd" (<a href>), ' +
              '"file:///etc/hosts" (<a href>), "javascript:alert(1)" (<a href>), "ftp://example.com/x" (<a href>)'
          ),
        ],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('names at most the reporting limit one by one, once each, and counts the rest', async () => {
    const total = MAX_NAMED_REFERENCES + 4;
    const links = Array.from({ length: total }, (_, i) => `<a href="page-${i}.html">p${i}</a><a href="page-${i}.html">again</a>`).join('');
    const { warnings } = await stageHtmlForNativeEngine(`<p>Index.</p>${links}`);
    const named = Array.from({ length: MAX_NAMED_REFERENCES }, (_, i) => `"page-${i}.html" (<a href>)`).join(', ');
    expect(warnings).toEqual([REFERENCES_WARNING(total, `${named}, and 4 more`)]);
  });

  oracleTest(
    'leaves out form controls, keeping the labels around them, and reports them once by element',
    TOOLS,
    async () => {
      const result = await convert(
        '<html><body><h1>Order form</h1><form action="submit.php" method="post"><p>Name: <input type="text" name="n" value="typed value"> ' +
          'Agree <input type="checkbox" name="c"> <select name="s"><option>Alpha<option>Beta</select></p><textarea name="t">typed note</textarea>' +
          '<input type="hidden" name="h" value="secret"><input type="submit" value="Send now"><input type="image" src="go.gif"></form><p>Closing line.</p></body></html>'
      );
      const text = pdfFacts(result.buffer).text;
      expect({
        kept: ['Order form', 'Name:', 'Agree', 'Closing line.'].map((phrase) => text.includes(phrase)),
        drawn: ['typed value', 'Alpha', 'Beta', 'typed note', 'secret', 'Send now'].filter((word) => text.includes(word)),
        warnings: warningsOf(result),
      }).toEqual({
        kept: [true, true, true, true],
        drawn: [],
        warnings: [ELEMENTS_WARNING(6, '<input> x 4, <select> x 1, <textarea> x 1')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  oracleTest(
    'leaves out media, SVG, canvas, frames, objects and applets with their fallbacks, keeping the rest of the page',
    TOOLS,
    async () => {
      const result = await convert(
        '<html><body><p>Before the media.</p><svg width="10" height="10"><text>svg words</text></svg><video src="m.mp4">video fallback</video>' +
          '<audio src="a.mp3"></audio><canvas>canvas fallback</canvas><iframe src="inner.html"></iframe><object data="x.swf">object fallback</object>' +
          '<embed src="y.swf"><applet code="A.class">applet fallback</applet><p>After the media.</p></body></html>'
      );
      const facts = pdfFacts(result.buffer);
      expect({ text: facts.text, warnings: warningsOf(result) }).toEqual({
        text: 'Before the media. After the media.',
        warnings: [ELEMENTS_WARNING(8, '<svg> x 1, <video> x 1, <audio> x 1, <canvas> x 1, <iframe> x 1, <object> x 1, <embed> x 1, <applet> x 1')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  describe('in CSS', () => {
    let server: ImageServer;
    let restore: (() => void) | undefined;

    beforeEach(async () => {
      server = await startImageServer();
      server.serve('/bg.png', await solidPng(8, 8, { r: 200, g: 20, b: 20 }));
      server.serve('/theme.css', 'p { color: red }', 'text/css');
      restore = overrideImageFetchRules({ hosts: { 'assets.test': ['127.0.0.1'] }, permitAddresses: ['127.0.0.1'], anyPort: true });
    });

    afterEach(async () => {
      restore?.();
      await server.close();
    });

    oracleTest(
      'drops a style sheet or a style attribute that names a picture or an import, fetches nothing, and reports each',
      TOOLS,
      async () => {
        const at = (file: string): string => `http://assets.test:${server.port}${file}`;
        const result = await convert(
          `<html><head><style>@import url("${at('/theme.css')}"); .hero { background: url(${at('/bg.png')}) }</style></head><body>` +
            '<p style="color: red; background-image: url(img/bg.gif)">Styled line.</p><p class="hero">Hero line.</p></body></html>'
        );
        expect({
          text: pdfFacts(result.buffer).text,
          images: pdfImageCount(result.buffer),
          requests: server.requests.length,
          warnings: warningsOf(result),
        }).toEqual({
          text: 'Styled line. Hero line.',
          images: 0,
          requests: 0,
          warnings: [REFERENCES_WARNING(2, `"${at('/theme.css')}" (style sheet), "img/bg.gif" (style attribute)`)],
        });
      },
      LIBREOFFICE_TIMEOUT_MS
    );
  });

  it('still refuses CSS that names a data: picture which is not embedded PNG, JPEG or GIF data', async () => {
    const refusal = 'is not embedded base64 PNG, JPEG or GIF data';
    const svg = stageHtmlForNativeEngine('<p style="background:url(data:image/svg+xml;base64,PHN2Zy8+)">svg</p>');
    await expect(svg).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(svg).rejects.toThrow(`"data:image/svg+xml;base64,PHN2Zy8+" ${refusal}`);
    const cssImport = stageHtmlForNativeEngine('<style>@import url("data:text/css;base64,cCB7IGNvbG9yOiByZWQgfQ==");</style><p>import</p>');
    await expect(cssImport).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(cssImport).rejects.toThrow(refusal);
  });
});

describe('nothing reaches the renderer or the network except through the image loader', () => {
  let server: ImageServer;
  let restore: (() => void) | undefined;

  beforeEach(async () => {
    server = await startImageServer();
    server.serve('/photo.png', await solidPng(24, 16, { r: 20, g: 120, b: 220 }));
    restore = overrideImageFetchRules({
      hosts: { 'images.test': ['127.0.0.1'], 'private.test': ['10.0.0.5'] },
      permitAddresses: ['127.0.0.1'],
      anyPort: true,
    });
  });

  afterEach(async () => {
    restore?.();
    await server.close();
  });

  const at = (file: string, host = 'images.test'): string => `http://${host}:${server.port}${file}`;

  it('hands the renderer no file:, relative, javascript:, protocol-relative or style sheet reference, and reads no local file', async () => {
    const handed = await handedToLibreOffice(
      '<html><head><link rel="stylesheet" href="file:///etc/hosts"><link rel="stylesheet" href="../../etc/passwd"><script src="file:///etc/hosts"></script>' +
        '<base href="file:///etc/"><meta http-equiv="refresh" content="0;url=file:///etc/hosts"></head><body background="file:///etc/hosts"><p>Secure page.</p>' +
        '<a href="file:///etc/hosts">f</a><a href="../../etc/passwd">t</a><a href="javascript:alert(1)">j</a><a href="//evil.test/x">p</a>' +
        '<a href="data:text/html;base64,PHNjcmlwdD4=">d</a><img src="file:///etc/hosts"><img src="../../etc/passwd"><img srcset="file:///etc/hosts 2x">' +
        '<p style="background:url(file:///etc/hosts)">c</p><iframe src="file:///etc/hosts"></iframe><form action="file:///etc/hosts"><input type="image" src="file:///etc/hosts"></form>' +
        '<a href="https://example.com/ok">kept</a></body></html>'
    );
    expect(handed).toContain('Secure page.');
    expect(handed).toContain('href="https://example.com/ok"');
    expect(handed).not.toMatch(/file:|passwd|etc\/hosts|javascript|evil\.test|data:text|<link|<script|<base|<meta http|<iframe|<form|url\(|background=/i);
    expect(server.requests).toEqual([]);
  });

  oracleTest(
    'embeds a fetched picture next to dropped links and leaves out a private-address picture, fetching only the public one',
    TOOLS,
    async () => {
      const result = await convert(
        `<html><body><p>Gallery.</p><a href="more.html">more</a><img src="${at('/photo.png')}"><img src="${at('/photo.png', 'private.test')}"></body></html>`
      );
      expect({
        text: pdfFacts(result.buffer).text,
        images: pdfImageCount(result.buffer),
        requested: server.requests.map((request) => request.url),
        warnings: warningsOf(result),
      }).toEqual({
        text: 'Gallery. more',
        images: 1,
        requested: ['/photo.png'],
        warnings: [`Left out the image "${at('/photo.png', 'private.test')}": the host is not a public address.`, REFERENCES_WARNING(1, '"more.html" (<a href>)')],
      });
    },
    LIBREOFFICE_TIMEOUT_MS
  );

  it('leaves a picture at a literal loopback or private address out under the production address rules', async () => {
    restore?.();
    restore = overrideImageFetchRules({ anyPort: true });
    const { warnings } = await stageHtmlForNativeEngine(
      `<p>Probe.</p><img src="http://127.0.0.1:${server.port}/photo.png"><img src="http://10.0.0.5/x.png"><img src="http://169.254.169.254/latest/meta-data/">`
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.filter((line) => line.endsWith('the host is not a public address.'))).toHaveLength(3);
    expect(server.requests).toEqual([]);
  });

  it('turns picture loading off with HTML_IMAGE_FETCH=off while still converting the rest', async () => {
    const previous = process.env.HTML_IMAGE_FETCH;
    process.env.HTML_IMAGE_FETCH = 'off';
    try {
      const { html, warnings } = await stageHtmlForNativeEngine(`<p>Off.</p><a href="more.html">more</a><img src="${at('/photo.png')}">`);
      expect(html).not.toMatch(/<img|more\.html/);
      expect(warnings).toEqual([`Left out the image "${at('/photo.png')}": ${IMAGES_OFF}.`, REFERENCES_WARNING(1, '"more.html" (<a href>)')]);
      expect(server.requests).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.HTML_IMAGE_FETCH;
      else process.env.HTML_IMAGE_FETCH = previous;
    }
  });

  it('requireResources refuses a picture that cannot be loaded, but not a link, style sheet, form or frame the PDF cannot carry', async () => {
    const strict = { requireResources: true };
    const others =
      '<link rel="stylesheet" href="style.css"><a href="more.html">more</a><form><input type="text"></form><iframe src="inner.html"></iframe><p style="background:url(b.gif)">x</p>';
    await expect(stageHtmlForNativeEngine(`<p>Strict.</p>${others}<img src="${at('/photo.png')}">`, strict)).resolves.toMatchObject({
      warnings: expect.arrayContaining([expect.stringContaining('more.html')]),
    });
    await expect(stageHtmlForNativeEngine(`<p>Strict.</p>${others}<img src="${at('/missing.png')}">`, strict)).rejects.toThrow(
      'could not be loaded: the server answered with status 404'
    );
  });
});
