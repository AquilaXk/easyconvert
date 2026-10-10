import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError } from '../src/lib/types';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { oracleTest } from './helpers/oracle-test';

/**
 * LibreOffice is tried first for Office pairs, but only for pairs it has an export filter for, and a file it cannot
 * open answers a typed 400 instead of an untyped failure (#671). The fixtures are written from ECMA-376 markup with
 * their text known in advance.
 */

const NATIVE_TIMEOUT_MS = 240_000;
const PARAGRAPHS = ['Quarterly review heading', 'Second paragraph about revenue growth'];

const slideTexts = async (pptx: Buffer): Promise<string[]> => {
  const zip = await JSZip.loadAsync(pptx);
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  const texts: string[] = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async('string');
    for (const match of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) texts.push(match[1]);
  }
  return texts;
};

describe('Office pairs through LibreOffice', () => {
  oracleTest('writes a text document as a presentation of its text, a pair LibreOffice has no export filter for', ['soffice'], async () => {
    const docx = await craftDocx({ body: PARAGRAPHS.map(paragraph).join('') });
    const result = await dispatchConversion(docx, 'docx', 'pptx', {}, 'review.docx');
    expect(result.filename).toBe('review.pptx');
    const texts = (await slideTexts(result.buffer)).join('\n');
    for (const line of PARAGRAPHS) expect(texts).toContain(line);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('answers a document LibreOffice cannot open with a typed 400, not an untyped failure', ['soffice'], async () => {
    const docx = await craftDocx({ body: PARAGRAPHS.map(paragraph).join('') });
    const truncated = docx.subarray(0, Math.floor(docx.length / 2));
    const run = dispatchConversion(truncated, 'docx', 'pdf', {}, 'cut.docx');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
  }, NATIVE_TIMEOUT_MS);

  it('keeps the cases above honest: a truncated package is not a readable ZIP', async () => {
    const docx = await craftDocx({ body: paragraph('x') });
    await expect(JSZip.loadAsync(docx.subarray(0, Math.floor(docx.length / 2)))).rejects.toThrow();
  });
});

describe('Presentations that LibreOffice opens as another kind of document', () => {
  oracleTest('answers a typed 400 for a .ppt that is plain text and has no presentation export filter', ['soffice'], async () => {
    const run = dispatchConversion(Buffer.from('Plain text, not a presentation.\n'), 'ppt', 'odp', {}, 'text.ppt');
    const error = await run.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toContain('LibreOffice could not read the .ppt file');
  }, NATIVE_TIMEOUT_MS);
});
