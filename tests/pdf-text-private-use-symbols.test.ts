import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { extraObjectNumber, rawPdf } from './helpers/raw-pdf';
import { hasControlCharacters } from './helpers/pdf-text-metrics';

/**
 * Glyph names that the Adobe Glyph List maps to the private-use area (the pieces of the big brackets of Symbol and CMEX10, the
 * serif and sans signs of copyright, registered and trademark): pdf.js puts the private-use character in the text, and the reader
 * writes the character pdf.js maps it to for drawing (`getSpecialPUASymbols`, pdf-glyph-list-pdfjs.ts). A private-use name
 * with no such character, like the small capital `AEsmall`, is still left out and counted. The PDFs are written by hand with a
 * Helvetica whose /Differences name the glyphs; no font carries a /ToUnicode map.
 */

const DIFFERENCES = '/Differences [1 /parenlefttp /parenleftex /parenleftbt 4 /copyrightserif /registersans /trademarkserif 7 /AEsmall]';

function documentShowing(shown: string): Buffer {
  const font = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding ${DIFFERENCES} >> >>`;
  const page = { width: 400, height: 200, content: `BT /F2 14 Tf 20 100 Td (${shown}) Tj ET`, fonts: `/F2 ${extraObjectNumber(1)} 0 R` };
  return rawPdf([page], [font]);
}

/** The characters of the page without the spaces: the glyphs have no width in a Helvetica, so the layout places them by its own rules. */
const withoutSpaces = (text: Buffer): string => text.toString('utf8').replace(/\s+/g, '');

async function textOf(shown: string, target: 'txt' | 'md' = 'txt') {
  return convertFile(documentShowing(shown), 'pdf', target, {}, 'private-use.pdf');
}

describe('private-use glyphs that have a character of their own', () => {
  it('reads the bracket pieces and the serif and sans signs', async () => {
    const result = await textOf('Total \\001\\002\\003 \\004 \\005 \\006 42');
    expect(withoutSpaces(result.buffer)).toBe('Total⎛⎜⎝©®™42');
    expect(result.metadata?.warnings).toBeUndefined();
  });

  it('gives the same characters in Markdown', async () => {
    const result = await textOf('Total \\001\\002\\003 \\004 42', 'md');
    expect(withoutSpaces(result.buffer)).toBe('Total⎛⎜⎝©42');
  });

  it('leaves out a private-use name that has no character of its own, and reports it', async () => {
    const result = await textOf('Total \\007 42 \\004');
    const text = result.buffer.toString('utf8');
    expect(hasControlCharacters(text)).toBe(false);
    expect(withoutSpaces(result.buffer)).toBe('Total42©');
    expect(result.metadata?.warnings).toEqual(['Left out 1 glyph that no font encoding maps to Unicode (page 1).']);
  });
});
