import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { convertFile } from '../src/lib/conversions/index';
import { stageHtmlForNativeEngine } from '../src/lib/conversions/html-native-staging';
import { overrideImageFetchRules } from '../src/lib/conversions/html-image-fetch';
import { ConversionFailedError } from '../src/lib/types';
import { pdfFacts } from './helpers/corpus-facts';
import { requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { oracleTest } from './helpers/oracle-test';
import { solidPng, startImageServer, type ImageServer } from './helpers/image-server';

/**
 * The in-process HTML renderer (the route without LibreOffice, or with an orientation) leaves out what a PDF cannot carry
 * (form controls, frames, SVG, media) with the warnings of the LibreOffice route, instead of refusing the page, and the
 * image loader fetches nothing for a subtree no route draws. pdftotext (through pdfFacts) reads the PDFs; a local
 * server on 127.0.0.1, answering for a public-looking host name, counts the requests.
 */

const HOST = 'images.test';
const LOOPBACK = '127.0.0.1';
const ELEMENTS_WARNING = (count: number, listing: string): string => `Left out elements that cannot be drawn (${count}): ${listing}.`;
const TOOLS: Array<'pdftotext' | 'pdfinfo'> = ['pdftotext', 'pdfinfo'];

/** Converts without LibreOffice, so the in-process renderer is the route. */
const inProcess = (html: string, options: Record<string, unknown> = {}): ReturnType<typeof convertFile> =>
  withMissingBinary('SOFFICE_PATH', () => convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', options, 'page.html'));

describe('the in-process renderer leaves out what it cannot draw', () => {
  oracleTest(
    'converts a page with a form, a frame and inline SVG, keeping its text and reporting each element once by tag',
    TOOLS,
    async () => {
      const result = await inProcess(
        '<html><body><h1>Order form</h1><form action="submit.php"><p>Name: <input type="text" value="typed value"> Agree <input type="checkbox">' +
          ' <select><option>Alpha<option>Beta</select></p><textarea>typed note</textarea><input type="hidden" value="secret"></form>' +
          '<p>Chart: <svg width="10" height="10"><text>svg words</text></svg> done.</p><iframe src="inner.html"></iframe><p>Closing line.</p></body></html>'
      );
      expect({ text: pdfFacts(result.buffer).text, warnings: result.metadata?.warnings }).toEqual({
        text: 'Order form Name: Agree Chart: done. Closing line.',
        warnings: [ELEMENTS_WARNING(6, '<input> x 2, <select> x 1, <textarea> x 1, <svg> x 1, <iframe> x 1')],
      });
    }
  );

  oracleTest(
    'converts a page that is only a frameset to a one-page PDF and reports the frameset',
    TOOLS,
    async () => {
      const result = await inProcess('<html><frameset cols="50%,50%"><frame src="a.html"><frame src="b.html"></frameset></html>');
      const facts = pdfFacts(result.buffer);
      expect({ pages: facts.pages, text: facts.text, warnings: result.metadata?.warnings }).toEqual({
        pages: 1,
        text: '',
        warnings: [ELEMENTS_WARNING(1, '<frameset> x 1')],
      });
    }
  );

  oracleTest(
    'leaves out the same elements when an orientation is requested, and applies it',
    TOOLS,
    async () => {
      const result = await convertFile(
        Buffer.from('<html><body><p>Kept text.</p><svg><text>gone</text></svg></body></html>', 'utf-8'),
        'html',
        'pdf',
        { orientation: 'landscape' },
        'page.html'
      );
      expect({ text: pdfFacts(result.buffer).text, warnings: result.metadata?.warnings }).toEqual({
        text: 'Kept text.',
        warnings: [ELEMENTS_WARNING(1, '<svg> x 1')],
      });
    }
  );

  oracleTest(
    'draws MathML as its text, in line or on a line of its own, without what a math renderer does not show',
    TOOLS,
    async () => {
      const result = await inProcess(
        '<html><body><p>Before <math><mi>x</mi><mo>+</mo><mn>1</mn></math> after.</p>' +
          '<math display="block"><semantics><mrow><mi>y</mi><mo>=</mo><mn>2</mn></mrow><annotation encoding="application/x-tex">y = 2 tex</annotation></semantics></math>' +
          '<p>Then <math><maction actiontype="toggle"><mi>shown</mi><mi>hidden</mi></maction><mphantom><mi>ghost</mi></mphantom></math> end.</p></body></html>'
      );
      const text = execFileSync(requireOracleTool('pdftotext'), ['-', '-'], { input: result.buffer, encoding: 'utf-8' });
      expect({ lines: text.split('\n').map((line) => line.trim()).filter(Boolean), warnings: result.metadata?.warnings }).toEqual({
        lines: ['Before x+1 after.', 'y=2', 'Then shown end.'],
        warnings: undefined,
      });
    }
  );

  oracleTest(
    'answers MathML nested hundreds of levels deep quickly, with a document or a typed refusal',
    TOOLS,
    async () => {
      const started = Date.now();
      const outcome = await inProcess(`<p>deep ${'<math><mrow>'.repeat(150)}<mi>z</mi>${'</mrow></math>'.repeat(150)}</p>`).then(
        (result) => pdfFacts(result.buffer).text,
        (error: unknown) => error
      );
      expect(outcome === 'deep z' || outcome instanceof ConversionFailedError).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  );
});

describe('the image loader fetches nothing inside a subtree no route draws', () => {
  let server: ImageServer;
  let restore: (() => void) | undefined;
  const at = (file: string): string => `http://${HOST}:${server.port}${file}`;

  beforeEach(async () => {
    server = await startImageServer();
    server.serve('/visible.png', await solidPng(8, 8, { r: 20, g: 120, b: 220 }));
    restore = overrideImageFetchRules({ hosts: { [HOST]: [LOOPBACK] }, permitAddresses: [LOOPBACK], anyPort: true });
  });

  afterEach(async () => {
    restore?.();
    await server.close();
  });

  const hiddenImages = (): string =>
    ['noscript', 'template', 'svg', 'video', 'canvas', 'audio', 'object'].map((tag) => `<${tag}><img src="${at(`/in-${tag}.png`)}"></${tag}>`).join('') +
    `<select><option><img src="${at('/in-select.png')}"></option></select><iframe src="inner.html"></iframe><picture><source srcset="${at('/visible.png')}"><img alt="x"></picture>`;

  it('makes no request for them on the in-process route and reports no image for them', async () => {
    const result = await inProcess(`<html><body><p>Text.</p>${hiddenImages()}</body></html>`);
    expect(server.requests.map((request) => request.url)).toEqual(['/visible.png']);
    expect(result.metadata?.warnings).toEqual([ELEMENTS_WARNING(7, '<svg> x 1, <video> x 1, <canvas> x 1, <audio> x 1, <object> x 1, <select> x 1, <iframe> x 1')]);
  });

  it('makes no request for them on the LibreOffice staging and reports no image for them', async () => {
    const staged = await stageHtmlForNativeEngine(`<html><body><p>Text.</p>${hiddenImages()}</body></html>`);
    expect(server.requests.map((request) => request.url)).toEqual(['/visible.png']);
    expect(staged.warnings).toEqual([ELEMENTS_WARNING(7, '<svg> x 1, <video> x 1, <canvas> x 1, <audio> x 1, <object> x 1, <select> x 1, <iframe> x 1')]);
  });
});
