import { describe, expect, it, vi } from 'vitest';
import { InlinePictureCollector, planPictureDecoding } from '../src/lib/conversions/pdf-picture-guard';
import { jpxCodestream } from '../src/lib/conversions/pdf-picture-headers';
import { pdfjsReadableBytes } from '../src/lib/conversions/pdf-reader-input';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { HELVETICA_FONT, buildPdf, textContent } from './helpers/pdf-craft';

vi.mock('../src/lib/conversions/pdf-picture-headers', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/conversions/pdf-picture-headers')>();
  return { ...original, jpxCodestream: vi.fn(original.jpxCodestream) };
});

/**
 * A header reader that fails on a picture's bytes must not refuse the document: the picture of an object is left out, as a
 * picture whose decoder fails is, and an inline picture, which cannot be left out, is left to the memory maximum of the decoders.
 * No known input makes a reader throw (the readers return null for a header they cannot read), so the readers are made to.
 */

const JPX_PICTURE = '/Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /JPXDecode';

function pdfWith(stream: Buffer, inline = ''): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << /Im0 10 0 R >> >>' },
      { id: 4, stream: Buffer.from(`${textContent('Pictures', 740)}q 64 0 0 32 72 700 cm /Im0 Do Q${inline}`, 'latin1') },
      { id: 5, raw: HELVETICA_FONT },
      { id: 10, dict: JPX_PICTURE, stream },
    ],
    1
  ).buffer;
}

function plan(pdf: Buffer): number[] {
  const inline = new InlinePictureCollector();
  return planPictureDecoding(assertPdfStreamsWithinLimits(pdf, inline.visit), inline).dropped.map(({ num }) => num);
}

describe('a header reader that throws on the bytes of a picture', () => {
  it('leaves out the image object it was reading, and the document is read', () => {
    vi.mocked(jpxCodestream).mockImplementationOnce(() => {
      throw new RangeError('The value of "offset" is out of range.');
    });
    expect(plan(pdfWith(Buffer.alloc(64)))).toEqual([10]);
  });

  it('leaves an inline picture to the decoder, without refusing the document', () => {
    vi.mocked(jpxCodestream).mockImplementation(() => {
      throw new RangeError('The value of "offset" is out of range.');
    });
    try {
      const inline = '\nq 64 0 0 32 72 600 cm BI /W 16 /H 16 /BPC 8 /CS /G /F /JPXDecode ID abcdefgh\nEI Q\n';
      const pdf = pdfWith(Buffer.alloc(64), inline);
      const readable = pdfjsReadableBytes(pdf, { content: true, pictures: true });
      // The update names the image object alone; the inline picture stays in the content as it is.
      expect(readable.subarray(0, pdf.length).equals(pdf)).toBe(true);
      expect([...readable.subarray(pdf.length).toString('latin1').matchAll(/(\d+) 0 obj\nnull\nendobj/g)].map((match) => match[1])).toEqual(['10']);
    } finally {
      vi.mocked(jpxCodestream).mockReset();
    }
  });

  it('does not hide an error that is not a RangeError', () => {
    vi.mocked(jpxCodestream).mockImplementationOnce(() => {
      throw new TypeError('a reader bug');
    });
    expect(() => plan(pdfWith(Buffer.alloc(64)))).toThrow(TypeError);
  });
});
