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
      expect(await warningsOf(UNLOADED_IMAGE, target)).toEqual(['The image "pictures/missing.png" could not be loaded and was left out.']);
    });

    it(`reports an svg element to ${target}`, async () => {
      expect(await warningsOf(INLINE_SVG, target)).toEqual(['A <svg> element cannot be carried and was left out.']);
    });

    it(`reports the frames of a frameset page once to ${target}`, async () => {
      expect(await warningsOf(FRAMESET, target)).toEqual(['A <frameset> element cannot be carried and was left out.']);
    });

    it(`reports each distinct line once when a page repeats the omission, to ${target}`, async () => {
      const twice = INLINE_SVG.replace('<p>After</p>', '<svg></svg><p>After</p>');
      expect(await warningsOf(twice, target)).toEqual(['A <svg> element cannot be carried and was left out.']);
    });

    it(`reports nothing for a page without such content to ${target}`, async () => {
      expect(await warningsOf(PLAIN, target)).toEqual([]);
    });
  }
});
