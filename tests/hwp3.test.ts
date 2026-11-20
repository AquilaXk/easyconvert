import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { parseHwpDocument } from '../src/lib/conversions/hwp';
import { UnsupportedHwpVersionError } from '../src/lib/conversions/hwp-version';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * HWP 3.x files (Hangul Word Processor 97 and earlier) are no compound files, so the in-process reader refuses them in words; the
 * office suite has an import filter for them, and the conversion goes through it. The sweep of 2026-11-20 answered the file of Apache
 * Tika's test set with "the file is not an OLE2 compound file".
 */

const SAMPLE = 'tika-testhwp_3.0.hwp';
const sofficeMissing = skipWithoutTools('soffice');
const CONVERSION_TIMEOUT_MS = 180_000;

describe('an HWP 3.x file in the in-process reader', () => {
  it('is refused as an HWP 3.0 file, with a typed 422 error', () => {
    const header = Buffer.concat([Buffer.from('HWP Document File V3.00 \x1a\x01\x02\x03\x04\x05', 'latin1'), Buffer.alloc(200)]);
    let failure: unknown;
    try {
      parseHwpDocument(header);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(UnsupportedHwpVersionError);
    expect((failure as UnsupportedHwpVersionError).message).toBe('HWP 3.0 files are not supported: this reader opens HWP 5.0 documents only.');
    expect((failure as UnsupportedHwpVersionError & { status: number }).status).toBe(422);
  });
});

const WORDS = ['테스트', 'test'];

/** The words (letters and digits, in order) of a text. */
function wordsOf(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The text of every `<tag>` element of an XML part of a package, in order. */
async function elementTexts(archive: Buffer, part: string, tag: string): Promise<string[]> {
  const xml = await (await JSZip.loadAsync(archive)).file(part)!.async('string');
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'g'))].map((match) => match[1]);
}

describe.skipIf(sofficeMissing)('an HWP 3.x file converted through the office suite', () => {
  it.for(['txt', 'md'] as const)('is written as .%s with the words of the document, in order', { timeout: CONVERSION_TIMEOUT_MS }, async (target, ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SAMPLE);
    const result = await dispatchConversion(bytes, 'hwp', target, {}, SAMPLE);
    expect(wordsOf(result.buffer.toString('utf-8'))).toEqual(WORDS);
  });

  it('is written as HTML with one paragraph for each line', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SAMPLE);
    const html = (await dispatchConversion(bytes, 'hwp', 'html', {}, SAMPLE)).buffer.toString('utf-8');
    expect([...html.matchAll(/<p[^>]*>(?:<a[^>]*><\/a>)?([^<]*)<\/p>/g)].map((match) => match[1])).toEqual(WORDS);
  });

  it('is written as DOCX and HWPX with the words as text runs', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SAMPLE);
    const docx = (await dispatchConversion(bytes, 'hwp', 'docx', {}, SAMPLE)).buffer;
    expect(await elementTexts(docx, 'word/document.xml', 'w:t')).toEqual(WORDS);
    const hwpx = (await dispatchConversion(bytes, 'hwp', 'hwpx', {}, SAMPLE)).buffer;
    expect(await elementTexts(hwpx, 'Contents/section0.xml', 'hp:t')).toEqual(WORDS);
  });

  it('is written as a PDF whose text is the words of the document', { timeout: CONVERSION_TIMEOUT_MS }, async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, SAMPLE);
    const result = await dispatchConversion(bytes, 'hwp', 'pdf', {}, SAMPLE);
    expect(wordsOf((await extractTextWithExternalPdftotext(result.buffer)) ?? '')).toEqual(WORDS);
  });
});
