import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { parseDocxXml } from '../src/lib/conversions/office';
import { craftDocx, paragraph } from './helpers/docx-craft';

/**
 * A phonetic guide in a Word document that draws a shape (ECMA-376 17.3.3.25 to 17.3.3.27). The drawing-aware reader takes the text of
 * the base (`rubyBase`) in its place among the runs, as the model reader does for a document without shapes, and not the guide (`rt`),
 * which it used to put in front of the base.
 */

const DRAWN_SHAPE =
  '<w:p><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/></wp:inline></w:drawing></w:r></w:p>';
const run = (text: string): string => `<w:r><w:t>${text}</w:t></w:r>`;
const rubyOf = (guide: string, base: string): string => `<w:ruby><w:rubyPr><w:rubyAlign w:val="distributeSpace"/></w:rubyPr><w:rt>${run(guide)}</w:rt><w:rubyBase>${run(base)}</w:rubyBase></w:ruby>`;
const inRun = (ruby: string): string => `<w:r>${ruby}</w:r>`;

describe('the drawing-aware reader of a Word document', () => {
  const parse = (body: string) => parseDocxXml(`<w:document><w:body>${body}</w:body></w:document>`);

  it.each([
    ['inside a run', `<w:p>${run('before ')}${inRun(rubyOf('とうきょう', '東京'))}${run(' after')}</w:p>`],
    ['directly under a paragraph', `<w:p>${run('before ')}${rubyOf('とうきょう', '東京')}${run(' after')}</w:p>`],
  ])('reads the base of a guide in place among the runs, %s', (_name, body) => {
    expect(parse(body).paragraphs.map((paragraph) => paragraph.text)).toEqual(['before 東京 after']);
  });

  it('reads the base of a guide in a table cell, and leaves the guide out of the cell text', () => {
    const cell = `<w:tbl><w:tr><w:tc><w:p>${inRun(rubyOf('じ', '字'))}</w:p></w:tc></w:tr></w:tbl>`;
    expect(parse(cell).tables[0].rows).toEqual([['字']]);
  });

  it('does not take the right-to-left property of a run for a guide', () => {
    expect(parse(`<w:p>${rubyOf('かん', '漢')}<w:r><w:rPr><w:rtl/></w:rPr><w:t>rtl run</w:t></w:r></w:p>`).paragraphs.map((paragraph) => paragraph.text)).toEqual(['漢rtl run']);
  });

  const PARAGRAPHS_OF: Readonly<Record<string, (output: Buffer) => Promise<string[]>>> = {
    html: async (output) => [...output.toString('utf-8').matchAll(/<p>([^<]*)<\/p>/g)].map((match) => match[1]),
    txt: async (output) => output.toString('utf-8').split(/\n+/),
    pptx: async (output) => [...(await (await JSZip.loadAsync(output)).file('ppt/slides/slide1.xml')!.async('string')).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((match) => match[1]),
  };

  it.each(Object.keys(PARAGRAPHS_OF))('writes the base text and not the guide when the document is converted to %s', async (target) => {
    const body = DRAWN_SHAPE + `<w:p>${inRun(rubyOf('とうきょう', '東京'))}${rubyOf('かん', '漢')}</w:p>${paragraph('plain')}`;
    const result = await dispatchConversion(await craftDocx({ body }), 'docx', target, {}, 'ruby.docx');
    expect((await PARAGRAPHS_OF[target](result.buffer)).filter((line) => line !== '').slice(-2)).toEqual(['東京漢', 'plain']);
  });
});
