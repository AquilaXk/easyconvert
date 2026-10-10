import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { readPptSlides, PPT_MAX_RECORD_DEPTH } from '../src/lib/conversions/office/ppt-reader';
import { EncryptedOfficeDocumentError, LegacyOfficeFormatError } from '../src/lib/conversions/office/legacy-office-errors';
import { ConversionFailedError, EngineUnavailableError } from '../src/lib/types';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { oracleTest } from './helpers/oracle-test';
import { extractFontsWithExternalPdffonts, extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';
import { withMissingBinary } from './helpers/native-tools';
import { buildCompoundFile } from './helpers/cfb-craft';
import { buildPptBinary } from './helpers/ppt-binary-builder';
import { flatOdp, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

const PLACEHOLDER_PATTERN = /Extracted document content|document content\b|\[Text:|Presentation slide content/i;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const FIXTURE_PPTX = path.resolve(__dirname, 'fixtures', 'golden', 'office', 'drawingml-shapes-presentation.pptx');

/** Three slides written by the test: accented Latin, Hangul, punctuation and a multi-line slide. */
const AUTHORED_SLIDES: string[][] = [
  ['First slide title', 'Café résumé 한국어'],
  ['Second slide'],
  ['Third “quoted” – slide', 'Bullet one', 'Bullet two 日本語'],
];

function texts(slides: { texts: string[] }[]): string[][] {
  return slides.map((slide) => slide.texts);
}

describe('PowerPoint 97-2003 text extraction from hand-written presentations', () => {
  it('reads TextCharsAtom and TextBytesAtom text of every slide in slide order', () => {
    const ppt = buildPptBinary({
      slides: [
        { shapes: [{ chars: 'Title 한국어' }, { bytes: 'Café “quoted” – €5' }] },
        { shapes: [{ chars: 'Line one\rLine two\u000BLine three' }] },
        { shapes: [{ bytes: 'Third slide' }] },
      ],
    });
    expect(texts(readPptSlides(ppt))).toEqual([['Title 한국어', 'Café “quoted” – €5'], ['Line one', 'Line two', 'Line three'], ['Third slide']]);
  });

  it('takes slide order from the slide list, not from where the records sit in the stream', () => {
    const ppt = buildPptBinary({
      slides: [{ shapes: [{ chars: 'Slide A' }] }, { shapes: [{ chars: 'Slide B' }] }, { shapes: [{ chars: 'Slide C' }] }],
      reverseSlideStorage: true,
    });
    expect(texts(readPptSlides(ppt))).toEqual([['Slide A'], ['Slide B'], ['Slide C']]);
  });

  it('resolves placeholder shapes through the outline text of the slide list', () => {
    const ppt = buildPptBinary({
      slides: [
        {
          outline: ['Title from outline', 'Bullet A\rBullet B', 'Never referenced'],
          shapes: [{ outlineIndex: 0 }, { chars: 'Inline box' }, { outlineIndex: 1 }],
        },
      ],
    });
    expect(texts(readPptSlides(ppt))).toEqual([['Title from outline', 'Inline box', 'Bullet A', 'Bullet B', 'Never referenced']]);
  });

  it('counts a text block without a text atom when numbering the outline text a shape refers to', () => {
    const ppt = buildPptBinary({
      slides: [
        { outline: [null, 'Body behind a slide number block'], shapes: [{ outlineIndex: 1 }] },
        { outline: ['Only block'], shapes: [{ outlineIndex: 0 }] },
      ],
    });
    expect(texts(readPptSlides(ppt))).toEqual([['Body behind a slide number block'], ['Only block']]);
  });

  it('reads neither master nor notes text, and drops field placeholder characters', () => {
    const ppt = buildPptBinary({
      slides: [{ shapes: [{ chars: 'Page * of deck', fieldAt: 5 }, { chars: 'Keep * literal star' }] }],
      masterText: 'MASTER-TITLE-STYLE',
      notesText: 'SPEAKER-NOTES-TEXT',
    });
    const slides = readPptSlides(ppt);
    expect(texts(slides)).toEqual([['Page  of deck', 'Keep * literal star']]);
  });

  it('lets the newest edit replace a slide and ignores the superseded record', () => {
    const ppt = buildPptBinary({
      slides: [{ shapes: [{ chars: 'Original first' }] }, { shapes: [{ chars: 'Original second' }] }],
      revisedSlides: { 1: { shapes: [{ chars: 'Revised second' }] } },
    });
    expect(texts(readPptSlides(ppt))).toEqual([['Original first'], ['Revised second']]);
  });

  it('keeps slides that hold no text in the numbering', () => {
    const ppt = buildPptBinary({ slides: [{ shapes: [{ chars: 'Only text' }] }, { shapes: [] }, { shapes: [{ chars: 'Last' }] }] });
    expect(readPptSlides(ppt).map((slide) => [slide.number, slide.texts])).toEqual([[1, ['Only text']], [2, []], [3, ['Last']]]);
  });
});

describe('PowerPoint 97-2003 conversion through the in-process engine', () => {
  const deck = () =>
    buildPptBinary({
      slides: AUTHORED_SLIDES.map((lines) => ({ shapes: lines.map((chars) => ({ chars })) })),
      masterText: 'MASTER-TITLE-STYLE',
    });

  it('converts to plain text with the slides in order and no placeholder', async () => {
    const result = await convertFile(deck(), 'ppt', 'txt', {}, 'deck.ppt');
    const text = result.buffer.toString('utf-8');
    expect(text).toBe('First slide title\nCafé résumé 한국어\n\nSecond slide\n\nThird “quoted” – slide\nBullet one\nBullet two 日本語');
    expect(text).not.toMatch(PLACEHOLDER_PATTERN);
  });

  it('converts to html with one titled card per slide and the master text left out', async () => {
    const result = await convertFile(deck(), 'ppt', 'html', {}, 'deck.ppt');
    const html = result.buffer.toString('utf-8');
    const titles = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((match) => match[1]);
    const bullets = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1]);
    expect(titles).toEqual(['First slide title', 'Second slide', 'Third “quoted” – slide']);
    expect(bullets).toEqual(['Café résumé 한국어', 'Bullet one', 'Bullet two 日本語']);
    expect(html).not.toContain('MASTER-TITLE-STYLE');
  });

  it('converts to pptx with one slide per source slide holding its text', async () => {
    const result = await convertFile(deck(), 'ppt', 'pptx', {}, 'deck.ppt');
    const zip = await JSZip.loadAsync(result.buffer);
    const slideXml = await Promise.all([1, 2, 3].map((n) => zip.file(`ppt/slides/slide${n}.xml`)!.async('text')));
    expect(slideXml[0]).toContain('First slide title');
    expect(slideXml[0]).toContain('Café résumé 한국어');
    expect(slideXml[1]).toContain('Second slide');
    expect(slideXml[2]).toContain('Bullet two 日本語');
    expect(zip.file('ppt/slides/slide4.xml')).toBeNull();
  });
});

describe('PowerPoint 97-2003 fail-closed behaviour', () => {
  function failure(input: Buffer): unknown {
    try {
      readPptSlides(input);
    } catch (err) {
      return err;
    }
    return undefined;
  }

  it('refuses bytes that are not a compound file instead of decoding them as UTF-8', () => {
    const thrown = failure(Buffer.from('Slide one\nSlide two\n', 'utf-8'));
    expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
    expect((thrown as LegacyOfficeFormatError).status).toBe(HTTP_BAD_REQUEST);
  });

  it('refuses a compound file without the Current User stream', () => {
    const cfb = buildCompoundFile([{ name: 'PowerPoint Document', data: Buffer.alloc(600) }]);
    expect((failure(cfb) as Error).message).toMatch(/"Current User" stream is missing/);
  });

  it('answers an encrypted presentation with a 422 error', () => {
    const thrown = failure(buildPptBinary({ slides: [{ shapes: [{ chars: 'Secret' }] }], encrypted: true }));
    expect(thrown).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((thrown as EncryptedOfficeDocumentError).status).toBe(HTTP_UNPROCESSABLE);
  });

  it('refuses a presentation whose edit history loops', () => {
    const thrown = failure(buildPptBinary({ slides: [{ shapes: [{ chars: 'Loop' }] }], loopingEditChain: true }));
    expect((thrown as Error).message).toMatch(/edit history/);
  });

  it('refuses records nested deeper than the limit', () => {
    const thrown = failure(buildPptBinary({ slides: [{ shapes: [{ chars: 'Deep' }] }], extraNesting: PPT_MAX_RECORD_DEPTH + 1 }));
    expect((thrown as Error).message).toMatch(new RegExp(`nested deeper than ${PPT_MAX_RECORD_DEPTH} levels`));
  });

  it('refuses a stream that is cut off before its newest edit record', () => {
    const thrown = failure(buildPptBinary({ slides: [{ shapes: [{ chars: 'Some text' }] }], truncateDocumentBy: 20 }));
    expect(thrown).toBeInstanceOf(LegacyOfficeFormatError);
    expect((thrown as Error).message).toMatch(/runs past its parent|longer than its parent|outside the/);
  });

  it('refuses a presentation whose slides hold no text', () => {
    const thrown = failure(buildPptBinary({ slides: [{ shapes: [] }, { shapes: [] }] }));
    expect((thrown as Error).message).toMatch(/holds no slide text/);
  });

  it('refuses an outline reference past the text blocks of the slide', () => {
    const thrown = failure(buildPptBinary({ slides: [{ outline: ['Only block'], shapes: [{ outlineIndex: 3 }] }] }));
    expect((thrown as Error).message).toMatch(/outline text 3/);
  });

  it('refuses an outline reference equal to the number of text blocks, which are numbered from zero', () => {
    const thrown = failure(buildPptBinary({ slides: [{ outline: [null, 'Second block'], shapes: [{ outlineIndex: 2 }] }] }));
    expect((thrown as Error).message).toMatch(/outline text 2, but the slide has 2/);
  });

  it('fails a malformed .ppt conversion with a typed 400 error and no UTF-8 slide', async () => {
    const run = convertFile(Buffer.from('plain text pretending to be a deck', 'utf-8'), 'ppt', 'txt', {}, 'bad.ppt');
    await expect(run).rejects.toBeInstanceOf(LegacyOfficeFormatError);
    await expect(run).rejects.toMatchObject({ status: HTTP_BAD_REQUEST });
  });
});

describe('PowerPoint 97-2003 text extraction against LibreOffice', () => {
  oracleTest('reads the text LibreOffice writes into a three-slide deck, slide by slide', ['soffice'], () => {
    const ppt = sofficeConvert(flatOdp(AUTHORED_SLIDES), 'fodp', 'ppt', 'ppt');
    expect(texts(readPptSlides(ppt))).toEqual(AUTHORED_SLIDES);
  }, 180_000);

  oracleTest('matches the text of the LibreOffice PDF render of a deck with title placeholders and a table', ['soffice', 'pdftotext'], () => {
    const ppt = sofficeConvert(fs.readFileSync(FIXTURE_PPTX), 'pptx', 'ppt', 'ppt');
    const pdf = sofficeConvert(ppt, 'ppt', 'pdf', 'pdf');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppt-oracle-'));
    try {
      fs.writeFileSync(path.join(dir, 'deck.pdf'), pdf);
      const rendered = execFileSync(requireOracleTool('pdftotext'), [path.join(dir, 'deck.pdf'), '-'], { encoding: 'utf-8' });
      const slides = readPptSlides(ppt);
      expect(slides).toHaveLength(3);
      expect(normalizeWhitespace(slides.flatMap((slide) => slide.texts).join(' '))).toBe(normalizeWhitespace(rendered));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);

  oracleTest('converts a LibreOffice deck to txt through the dispatcher in slide order', ['soffice'], async () => {
    const ppt = sofficeConvert(flatOdp(AUTHORED_SLIDES), 'fodp', 'ppt', 'ppt');
    const result = await convertFile(ppt, 'ppt', 'txt', {}, 'deck.ppt');
    expect(result.buffer.toString('utf-8')).toBe(AUTHORED_SLIDES.map((lines) => lines.join('\n')).join('\n\n'));
  }, 180_000);
});

describe('PowerPoint 97-2003 symbol-font characters', () => {
  /** Symbol and Wingdings keep bullets and arrows at U+F020-U+F0FF; the font named on the run says which glyph that is. */
  const SYMBOL_DECK = buildPptBinary({
    slides: [
      {
        shapes: [
          {
            chars: 'Gain \uF061 \uF0B7 ok \uF0FC \uF0A7 end',
            fontRuns: [
              { count: 5, font: 'Arial' },
              { count: 1, font: 'Arial', symbolFont: 'Symbol' },
              { count: 1, font: 'Arial' },
              { count: 1, font: 'Arial', symbolFont: 'Symbol' },
              { count: 4, font: 'Arial' },
              { count: 1, font: 'Arial', symbolFont: 'Wingdings' },
              { count: 1, font: 'Arial' },
              { count: 1, font: 'Arial', symbolFont: 'Wingdings' },
              { count: 4, font: 'Arial' },
            ],
          },
        ],
      },
    ],
  });

  it('maps private-use characters to the Unicode characters their symbol font draws', () => {
    expect(texts(readPptSlides(SYMBOL_DECK))).toEqual([['Gain \u03B1 \u2022 ok \u2713 \u25AA end']]);
  });

  it('uses the typeface of a run that sets no symbol typeface', () => {
    const ppt = buildPptBinary({ slides: [{ shapes: [{ chars: '\uF0FC Done', fontRuns: [{ count: 1, font: 'Wingdings' }, { count: 5, font: 'Arial' }] }] }] });
    expect(texts(readPptSlides(ppt))).toEqual([['\u2713 Done']]);
  });

  it('keeps private-use characters of fonts that are not symbol fonts, so that no glyph is invented for them', () => {
    const ppt = buildPptBinary({
      slides: [{ shapes: [{ chars: '\uF0FC\uF0FC', fontRuns: [{ count: 1, font: 'Arial' }, { count: 1, symbolFont: 'Math1' }] }] }],
    });
    expect(texts(readPptSlides(ppt))).toEqual([['\uF0FC\uF0FC']]);
  });

  it('keeps a private-use character whose symbol font has no counterpart for its code', () => {
    const ppt = buildPptBinary({ slides: [{ shapes: [{ chars: '\uF0FF', fontRuns: [{ count: 1, symbolFont: 'Wingdings' }] }] }] });
    expect(texts(readPptSlides(ppt))).toEqual([['\uF0FF']]);
  });

  it('keeps private-use characters when the block has no character formatting', () => {
    const ppt = buildPptBinary({ slides: [{ shapes: [{ chars: 'Bullet \uF0FC' }] }] });
    expect(texts(readPptSlides(ppt))).toEqual([['Bullet \uF0FC']]);
  });

  oracleTest('writes the mapped characters into a PDF whose text and embedded fonts a separate PDF reader confirms', ['pdftotext', 'pdffonts'], async () => {
    const result = await convertFile(SYMBOL_DECK, 'ppt', 'pdf', {}, 'symbols.ppt');
    const extracted = normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '');
    expect(extracted).toBe('Gain \u03B1 \u2022 ok \u2713 \u25AA end');
    const fonts = extractFontsWithExternalPdffonts(result.buffer);
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((font) => font.emb)).toBe(true);
  });

  it('still refuses a private-use character of a font it has no table for, with a typed 400 error', async () => {
    const ppt = buildPptBinary({ slides: [{ shapes: [{ chars: 'Sum \uF073', fontRuns: [{ count: 4, font: 'Arial' }, { count: 1, symbolFont: 'Mathematica1' }] }] }] });
    const run = convertFile(ppt, 'ppt', 'pdf', {}, 'math.ppt');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toMatchObject({ message: expect.stringContaining('U+F073') });
  });
});

describe('PowerPoint templates and Keynote', () => {
  oracleTest('reads a LibreOffice POTX as a presentation and converts it to pdf and pptx', ['soffice', 'pdftotext'], async () => {
    const potx = sofficeConvert(flatOdp(AUTHORED_SLIDES), 'fodp', 'potx', 'potx');
    const pdf = await convertFile(potx, 'potx', 'pdf', {}, 'template.potx');
    const rendered = normalizeWhitespace(extractTextWithExternalPdftotext(pdf.buffer) ?? '');
    for (const line of AUTHORED_SLIDES.flat()) expect(rendered).toContain(normalizeWhitespace(line));
    expect(rendered).not.toMatch(PLACEHOLDER_PATTERN);

    const pptx = await convertFile(potx, 'potx', 'pptx', {}, 'template.potx');
    const zip = await JSZip.loadAsync(pptx.buffer);
    const contentTypes = await zip.file('[Content_Types].xml')!.async('text');
    expect(contentTypes).toContain('presentationml.presentation.main+xml');
    expect(contentTypes).not.toContain('presentationml.template.main+xml');
  }, 180_000);

  it('refuses a POTX that is not an OpenXML package with a typed 400 error', async () => {
    const notZip = Buffer.from('PK\u0003\u0004 but not a zip archive', 'latin1');
    const run = convertFile(notZip, 'potx', 'pdf', {}, 'bad.potx');
    await expect(run).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'The POTX file is not a valid OpenXML package.' });
  });

  it('never reads a Keynote file as UTF-8 text: it needs LibreOffice and answers with a typed 503 error', async () => {
    const zip = new JSZip();
    zip.file('Index/Document.iwa', Buffer.from([0x00, 0x01, 0x02]));
    const key = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(convertFile(key, 'key', 'pdf', {}, 'talk.key')).rejects.toBeInstanceOf(EngineUnavailableError);
    const missing = withMissingBinary('SOFFICE_PATH', () => dispatchConversion(key, 'key', 'pdf', {}, 'talk.key'));
    await expect(missing).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(missing).rejects.toMatchObject({ engineName: 'soffice' });
  });
});
