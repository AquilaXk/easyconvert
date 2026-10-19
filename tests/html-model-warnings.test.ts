import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';

/**
 * What the HTML reader leaves out of the document model reaches `metadata.warnings` of the Word, ODF and EPUB results
 * (policies 7 and 55): an image that cannot be loaded, an `<svg>` element and the frames of a frameset page. Before, the
 * reader collected the lines on the model and no writer passed them on, so the results converted without a word.
 * The expected lines are written out here, not read from the reader.
 */

const TARGETS = ['docx', 'odt', 'epub'] as const;

const UNLOADED_IMAGE = '<html><body><p>Before</p><img src="pictures/missing.png" alt="x"><p>After</p></body></html>';
const INLINE_SVG = '<html><body><p>Before</p><svg width="10" height="10"><circle cx="5" cy="5" r="4"/></svg><p>After</p></body></html>';
const FRAMESET =
  '<html><head><title>Frames</title></head><frameset cols="50%,50%"><frame src="left.html"><frame src="right.html"></frameset></html>';
const PLAIN = '<html><body><h1>Title</h1><p>Words only.</p><ul><li>one</li></ul></body></html>';

async function warningsOf(html: string, target: (typeof TARGETS)[number]): Promise<string[]> {
  const result = await convertFile(Buffer.from(html), 'html', target, {}, 'page.html');
  return (result.metadata?.warnings ?? []) as string[];
}

describe('warnings of the HTML reader on the Word, ODF and EPUB results', () => {
  for (const target of TARGETS) {
    it(`reports an image that cannot be loaded to ${target}`, async () => {
      expect(await warningsOf(UNLOADED_IMAGE, target)).toEqual(['Left out the image "pictures/missing.png": only images embedded in the page or its package are read.']);
    });

    it(`reports an svg element to ${target}`, async () => {
      expect(await warningsOf(INLINE_SVG, target)).toEqual(['Left out elements that cannot be drawn (1): <svg> x 1.']);
    });

    it(`reports the frames of a frameset page once to ${target}`, async () => {
      expect(await warningsOf(FRAMESET, target)).toEqual(['Left out elements that cannot be drawn (1): <frameset> x 1.']);
    });

    it(`counts the elements of one tag in a single line, to ${target}`, async () => {
      const twice = INLINE_SVG.replace('<p>After</p>', '<svg></svg><p>After</p>');
      expect(await warningsOf(twice, target)).toEqual(['Left out elements that cannot be drawn (2): <svg> x 2.']);
    });

    it(`counts the elements of different tags in a single line, to ${target}`, async () => {
      const mixed = INLINE_SVG.replace('<p>After</p>', '<canvas></canvas><svg></svg><p>After</p>');
      expect(await warningsOf(mixed, target)).toEqual(['Left out elements that cannot be drawn (3): <svg> x 2, <canvas> x 1.']);
    });

    it(`quotes an image reference with a control code and astral characters as the PDF routes do, to ${target}`, async () => {
      const reference = `a\u0007b${'\u{1F600}'.repeat(130)}`;
      const lines = await warningsOf(`<html><body><img src="${reference}"></body></html>`, target);
      // 120 code points (a, space for the control code, b, 117 faces), then an ellipsis: no pair is split.
      expect(lines).toEqual([`Left out the image "a b${'\u{1F600}'.repeat(117)}…": only images embedded in the page or its package are read.`]);
    });

    it(`lists at most 50 unloadable images and counts the rest, to ${target}`, async () => {
      const images = Array.from({ length: 53 }, (_, index) => `<img src="p${index}.png">`).join('');
      const lines = await warningsOf(`<html><body>${images}</body></html>`, target);
      expect(lines).toHaveLength(51);
      expect(lines[0]).toBe('Left out the image "p0.png": only images embedded in the page or its package are read.');
      expect(lines[50]).toBe('Left out 3 more external images that could not be loaded.');
    });

    it(`reports nothing for a page without such content to ${target}`, async () => {
      expect(await warningsOf(PLAIN, target)).toEqual([]);
    });
  }
});
