import { describe, expect, it } from 'vitest';
import { convertDocument } from '../src/lib/conversions/document';
import { rawPdf, run } from './helpers/raw-pdf';

/**
 * A list counted in lower-case roman numerals shares spellings with letter counters ("i.", "v.", "x."). The whole
 * sequence must stay one list, whatever reading each marker has on its own.
 */

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 72;
const TOP = 700;
const LINE_STEP = 18;
const BODY_SIZE = 12;
const LABELS = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi'];
const WORDS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo'];

function romanListPdf(): Buffer {
  const content = LABELS.map((label, index) => run(`${label}. ${WORDS[index]} item text`, LEFT, TOP - index * LINE_STEP, BODY_SIZE)).join('');
  return rawPdf([{ width: PAGE_WIDTH, height: PAGE_HEIGHT, content }]);
}

describe('roman-numeral lists in PDF conversions', () => {
  it('keeps i. to xi. as one list with roman counters', async () => {
    const result = await convertDocument(romanListPdf(), 'pdf', 'html', {}, 'roman.pdf');
    const html = result.buffer.toString('utf-8');
    const body = html.slice(html.indexOf('<body>'));
    expect(body.match(/<ol\b/g)).toHaveLength(1);
    expect(body).toContain('<ol type="i">');
    const items = [...body.matchAll(/<li>([^<]*)<\/li>/g)].map((match) => match[1]);
    expect(items).toEqual(WORDS.map((word) => `${word} item text`));
  });
});
