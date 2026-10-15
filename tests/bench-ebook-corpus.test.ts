import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORPUS_DIR } from '../bench/config';
import { textOfEpub } from '../bench/families/ebook';
import { structureOfEpub } from '../bench/structure-extract';
import { wordF1 } from '../bench/text-metrics';

/**
 * The book of the ebook rows is the truth of its own scoring: the text its EPUB, its FB2 and its MOBI hold must be the text it
 * was written from, read by the benchmark's readers (the package spine reader, the WHATWG structure reader), not by the product.
 */

const book = (name: string): Buffer => fs.readFileSync(path.join(CORPUS_DIR, 'ebooks', name));
const truth = book('book.gt.txt').toString('utf8');

describe('the corpus book', () => {
  it('reads back from its EPUB as the text it was written from', async () => {
    const text = await textOfEpub(book('book.epub'));
    expect(wordF1(truth, text)).toBeGreaterThan(0.999);
    expect(text).toContain('Tide & Timber');
    expect(text).toContain('café');
  });

  it('has the ten chapters as headings, a list, a table and its one picture in the EPUB', async () => {
    const structure = await structureOfEpub(book('book.epub'));
    expect(structure.headings).toHaveLength(10);
    expect(structure.headings[0]).toMatch(/^1\|Chapter 1: /);
    expect(structure.listItems.length).toBeGreaterThanOrEqual(3);
    expect(structure.tableCells.length).toBeGreaterThanOrEqual(12);
    expect(structure.images).toHaveLength(1);
  });

  it('holds the same words in the FB2 and the title in the MOBI', () => {
    const fb2 = book('book.fb2').toString('utf8').replace(/<binary[\s\S]*?<\/binary>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
    expect(wordF1(truth, fb2)).toBeGreaterThan(0.99);
    expect(book('book.mobi').includes(Buffer.from('The Quiet Harbour Survey'))).toBe(true);
  });
});
