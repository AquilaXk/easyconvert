import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { extractTextFromPdf } from '../src/lib/conversions/document';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * An `<img>` with no `src`, or with an empty one, is an image whose request is broken (HTML Living Standard, "update the
 * image data": a selected source of null). The page still converts. The element represents the text of its `alt` when that
 * is not empty and nothing otherwise, and is drawn as that text, or not at all (rendering, "Embedded content", the img
 * element that represents some text, and the one that represents nothing). Chrome prints the same page the same way.
 */

const SAMPLE_TIMEOUT_MS = 60_000;
const EMPTY_SOURCE_IMG = /<img\b[^>]*\bsrc=""[^>]*>/gi;
const MIN_PAGE_TEXT = 500;
const toPdf = async (html: string): Promise<Buffer> => (await convertFile(Buffer.from(html, 'utf-8'), 'html', 'pdf', {}, 'page.html')).buffer;
const textOf = async (html: string): Promise<string> => extractTextFromPdf(await toPdf(html));

describe('an img without a source converts like a browser prints it', () => {
  const imageFetch = process.env.HTML_IMAGE_FETCH;
  beforeEach(() => {
    process.env.HTML_IMAGE_FETCH = 'off';
  });
  afterEach(() => {
    if (imageFetch === undefined) delete process.env.HTML_IMAGE_FETCH;
    else process.env.HTML_IMAGE_FETCH = imageFetch;
  });

  it('draws the alt text of an img with an empty src or none, inline in its paragraph', async () => {
    const text = await textOf(
      '<body><p>one before <img src="" alt="Chart of sales"> one after</p><p>two before <img alt="Site logo"> two after</p><h2>Heading <img src="" alt="mark"> end</h2></body>'
    );
    expect(text).toBe('one before Chart of sales one after\n\ntwo before Site logo two after\n\nHeading mark end');
  });

  it('draws nothing for an img without alt text, whatever its size', async () => {
    const text = await textOf('<body><p>three before <img src="" width="1" height="1"> three after</p><p>four before <img src="" alt=""> four after</p><p>five before <img> five after</p></body>');
    expect(text).toBe('three before three after\n\nfour before four after\n\nfive before five after');
  });

  it('converts a page that has such an img in a table cell and in a link', async () => {
    const text = await textOf('<body><table><tr><td><img src=""> cell</td></tr></table><p><a href="https://example.com/">go <img alt="arrow"></a></p></body>');
    expect(text).toBe('cell\n\ngo arrow');
  });

  for (const id of ['govdocs1-000449.html', 'govdocs1-001121.html']) {
    it(`${id} (a one-pixel <img src="">) has the text of the page without that img`, async (ctx) => {
      const html = (await requireRealworldSample(ctx, id)).bytes.toString('latin1');
      const without = html.replace(EMPTY_SOURCE_IMG, '');
      expect(without).not.toBe(html);
      const text = await textOf(html);
      expect(text).toBe(await textOf(without));
      expect(text.length).toBeGreaterThan(MIN_PAGE_TEXT);
    }, SAMPLE_TIMEOUT_MS);
  }
});
