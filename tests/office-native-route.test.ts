import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { ConversionFailedError } from '../src/lib/types';
import { craftDocx, paragraph } from './helpers/docx-craft';
import { oracleTest } from './helpers/oracle-test';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';

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
    await expect(run).rejects.toThrow('LibreOffice could not read the .docx file');
  }, NATIVE_TIMEOUT_MS);

  it('keeps the cases above honest: a truncated package is not a readable ZIP', async () => {
    const docx = await craftDocx({ body: paragraph('x') });
    await expect(JSZip.loadAsync(docx.subarray(0, Math.floor(docx.length / 2)))).rejects.toThrow(/end of central directory/);
  });
});

describe('Presentations that LibreOffice opens as another kind of document', () => {
  oracleTest('answers a typed 400 for a .ppt that is plain text and has no presentation export filter', ['soffice'], async () => {
    const run = dispatchConversion(Buffer.from('Plain text, not a presentation.\n'), 'ppt', 'odp', {}, 'text.ppt');
    await expect(run).rejects.toThrow('LibreOffice could not read the .ppt file: it is damaged');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
  }, NATIVE_TIMEOUT_MS);
});

describe('Macro-enabled documents through LibreOffice', () => {
  oracleTest('renders a macro-enabled document to a PDF holding its text', ['soffice', 'pdftotext'], async () => {
    const plain = await craftDocx({ body: PARAGRAPHS.map(paragraph).join('') });
    const zip = await JSZip.loadAsync(plain);
    const types = await zip.file('[Content_Types].xml')!.async('string');
    zip.file('[Content_Types].xml', types.replace('wordprocessingml.document.main+xml', 'ms-word.document.macroEnabled.main+xml').replace('openxmlformats-officedocument.ms-word', 'ms-word'));
    const result = await dispatchConversion(await zip.generateAsync({ type: 'nodebuffer' }), 'docm', 'pdf', {}, 'macro.docm');
    const text = extractTextWithExternalPdftotext(result.buffer) ?? '';
    for (const line of PARAGRAPHS) expect(text).toContain(line);
  }, NATIVE_TIMEOUT_MS);
});
