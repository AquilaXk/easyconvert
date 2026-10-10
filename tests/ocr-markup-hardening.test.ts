import { describe, expect, it } from 'vitest';
import {
  OCR_MARKUP_MAX_ATTRIBUTE_CHARS,
  OCR_MARKUP_MAX_CHARS,
  OCR_MARKUP_MAX_TEXT_CHARS,
  OcrMarkupError,
  readMarkup,
  type MarkupHandler,
} from '../src/lib/conversions/ocr-markup';
import { parseAlto, parseHocr } from '../src/lib/conversions/ocr-import';

/**
 * Hardening of the hOCR / ALTO reader (linear running time is in ocr-markup-hardening.perf.test.ts): bounded memory, XML 1.0 character and
 * declaration rules, HTML5-serialized hOCR, and strict numeric syntax. All inputs are hand-written
 * or generated here; expected values are worked out from the inputs.
 */

const NOOP: MarkupHandler = { open: () => {}, text: () => {}, close: () => {} };
function openedNames(xml: string): string[] {
  const names: string[] = [];
  readMarkup(xml, { ...NOOP, open: (name) => names.push(name) });
  return names;
}

function expectMarkupError(run: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(OcrMarkupError);
  expect((thrown as OcrMarkupError).message).toMatch(message);
}

describe('reader memory bounds', () => {
  it('limits a document to 32 MiB, enough for several hundred dense hOCR pages at about 150 bytes a word', () => {
    expect(OCR_MARKUP_MAX_CHARS).toBe(32 * 1024 * 1024);
    expectMarkupError(() => readMarkup('a'.repeat(OCR_MARKUP_MAX_CHARS + 1), NOOP), /larger than/);
  });

  it('accepts an attribute value of the maximum length and rejects one character more, before decoding it', () => {
    const attribute = (length: number): string => `<a b="${'\n'.repeat(length)}"/>`;
    let seen = '';
    readMarkup(attribute(OCR_MARKUP_MAX_ATTRIBUTE_CHARS), {
      ...NOOP,
      open: (_name, attributes) => {
        seen = attributes.b;
      },
    });
    expect(seen).toBe(' '.repeat(OCR_MARKUP_MAX_ATTRIBUTE_CHARS));
    expectMarkupError(() => readMarkup(attribute(OCR_MARKUP_MAX_ATTRIBUTE_CHARS + 1), NOOP), /attribute b value is longer than/);
  });

  it('accepts a text node of the maximum length and rejects one character more, in text and in CDATA', () => {
    let length = 0;
    const counting: MarkupHandler = {
      ...NOOP,
      text: (text) => {
        length += text.length;
      },
    };
    const references = Math.floor(OCR_MARKUP_MAX_TEXT_CHARS / '&amp;'.length);
    readMarkup(`<a>${'&amp;'.repeat(references)}</a>`, counting);
    expect(length).toBe(references);
    expectMarkupError(() => readMarkup(`<a>${'x'.repeat(OCR_MARKUP_MAX_TEXT_CHARS + 1)}</a>`, NOOP), /text is longer than/);
    expectMarkupError(
      () => readMarkup(`<a><![CDATA[${'x'.repeat(OCR_MARKUP_MAX_TEXT_CHARS + 1)}]]></a>`, NOOP),
      /text is longer than/
    );
  });
});

describe('XML 1.0 character and declaration rules', () => {
  const CASES: Array<[string, string]> = [
    ['a control character in text', '<a>x\u0001y</a>'],
    ['a control character in an attribute value', '<a b="x\u0008y"/>'],
    ['a control character in a comment', '<a><!-- \u0000 --></a>'],
    ['U+FFFE', '<a>￾</a>'],
    ['U+FFFF', '<a b="￿"/>'],
    ['a lone high surrogate', '<a>\uD800x</a>'],
    ['a lone low surrogate', '<a>x\uDC00</a>'],
  ];
  for (const [name, xml] of CASES) {
    it(`rejects ${name}`, () => expectMarkupError(() => readMarkup(xml, NOOP), /not allowed in XML/));
  }

  it('accepts tab, line feed, carriage return and a valid surrogate pair', () => {
    let text = '';
    readMarkup('<a>\t\n\r\u{1F600}</a>', { ...NOOP, text: (t) => (text += t) });
    expect(text).toBe('\t\n\r\u{1F600}');
  });

  it('accepts an XML declaration at the very start, after a byte order mark', () => {
    expect(openedNames('\uFEFF<?xml version="1.0" encoding="UTF-8"?><a/>')).toEqual(['a']);
  });

  const MISPLACED: Array<[string, string]> = [
    ['after white space', ' <?xml version="1.0"?><a/>'],
    ['after a comment', '<!-- c --><?xml version="1.0"?><a/>'],
    ['twice', '<?xml version="1.0"?><?xml version="1.0"?><a/>'],
    ['inside the root', '<a><?xml version="1.0"?></a>'],
    ['in another letter case', '<a/><?XML version="1.0"?>'],
  ];
  for (const [name, xml] of MISPLACED) {
    it(`rejects an XML declaration ${name}`, () => expectMarkupError(() => readMarkup(xml, NOOP), /XML declaration/));
  }

  it('allows other processing instructions anywhere, including ones whose target starts with xml', () => {
    expect(openedNames('<?xml-stylesheet href="a.css"?><a><?pi x?><b/></a>')).toEqual(['a', 'b']);
  });
});

describe('HTML5-serialized hOCR', () => {
  const HTML5_HOCR = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="ocr-system" content="reference">
<title>scan</title>
<link rel="stylesheet" href="x.css">
</head>
<body>
<div class="ocr_page" title="bbox 0 0 100 50; ppageno 0">
<div class="ocr_carea" title="bbox 1 1 99 49">
<p class="ocr_par" title="bbox 1 1 99 49">
<span class="ocr_line" title="bbox 1 1 99 20; baseline 0 -2">
<span class="ocrx_word" title="bbox 1 1 40 20; x_wconf 91">A&nbsp;B</span><br>
<span class="ocrx_word" title="bbox 50 1 99 20; x_wconf 92">caf&eacute; &copy;</span><img src="x.png"></span></p></div></div></body></html>`;

  it('reads unclosed void elements and common HTML named entities', () => {
    const parsed = parseHocr(HTML5_HOCR);
    expect(parsed.text).toBe('A B café ©');
    expect(parsed.lineBlocks).toHaveLength(1);
    expect(parsed.lineBlocks?.[0].words.map((w) => [w.text, w.confidence])).toEqual([
      ['A B', 0.91],
      ['café ©', 0.92],
    ]);
    expect(parsed.language).toBe('en');
  });

  it('accepts a void element that is also closed XHTML-style', () => {
    const parsed = parseHocr(
      '<html><head><meta charset="utf-8"></meta><br></br></head><body><div class="ocr_page" title="bbox 0 0 9 9"/></body></html>'
    );
    expect(parsed.pages).toHaveLength(1);
  });

  it('keeps other elements strict in hOCR', () => {
    expectMarkupError(() => parseHocr('<html><body><div class="ocr_page" title="bbox 0 0 9 9"><p></div></body></html>'), /does not match/);
    expectMarkupError(() => parseHocr('<html><body>&bogus;</body></html>'), /unknown or malformed character reference/);
  });

  it('applies the HTML rules to hOCR only, not to ALTO or the plain reader', () => {
    const alto = (extra: string): string =>
      `<alto><Layout><Page WIDTH="10" HEIGHT="10">${extra}</Page></Layout></alto>`;
    expectMarkupError(() => parseAlto(alto('<br>')), /is not closed|does not match/);
    expectMarkupError(() => parseAlto(alto('&nbsp;')), /unknown or malformed character reference/);
    expectMarkupError(() => readMarkup('<a><br></a>', NOOP), /does not match/);
  });

  it('still rejects empty input and input with no ocr_page', () => {
    expectMarkupError(() => parseHocr(''), /empty/);
    expectMarkupError(() => parseHocr('<!DOCTYPE html><html><body><br></body></html>'), /no ocr_page/);
  });
});

describe('numeric syntax', () => {
  const page = (title: string, body = ''): string => `<div class="ocr_page" title="${title}">${body}</div>`;
  const line = (title: string, word = 'bbox 0 0 5 5'): string =>
    `<span class="ocr_line" title="${title}"><span class="ocrx_word" title="${word}">x</span></span>`;

  const BAD_HOCR: Array<[string, string, RegExp]> = [
    ['a hexadecimal bbox value', page('bbox 0x10 0 5 5'), /decimal integer/],
    ['an exponent in a bbox', page('bbox 0 0 1e300 5'), /decimal integer/],
    ['a fractional bbox value', page('bbox 0 0 5.5 5'), /decimal integer/],
    ['a negative bbox value', page('bbox -1 0 5 5'), /outside 0\.\./],
    ['a bbox above the coordinate bound', page('bbox 0 0 1000001 5'), /outside 0\.\./],
    ['a zero-width page', page('bbox 0 0 0 100'), /zero area/],
    ['a zero-height page', page('bbox 5 5 50 5'), /zero area/],
    ['a hexadecimal ppageno', page('bbox 0 0 9 9; ppageno 0x1'), /decimal integer/],
    ['a negative ppageno', page('bbox 0 0 9 9; ppageno -1'), /outside 0\.\./],
    ['an exponent x_wconf', page('bbox 0 0 9 9', line('bbox 0 0 5 5', 'bbox 0 0 5 5; x_wconf 1e2')), /decimal number/],
    ['an x_wconf above 100', page('bbox 0 0 9 9', line('bbox 0 0 5 5', 'bbox 0 0 5 5; x_wconf 101')), /outside 0\.\.100/],
    ['a hexadecimal baseline slope', page('bbox 0 0 9 9', line('bbox 0 0 5 5; baseline 0x1 0')), /decimal number/],
    ['an exponent baseline offset', page('bbox 0 0 9 9', line('bbox 0 0 5 5; baseline 0 1e300')), /decimal number/],
    ['a baseline that leaves the page bound', page('bbox 0 0 9 9', line('bbox 0 0 900000 5; baseline 9999 0')), /outside/],
    ['an infinite x_size', page('bbox 0 0 9 9', line('bbox 0 0 5 5; x_size Infinity')), /decimal number/],
    ['a plus sign', page('bbox 0 0 +9 9'), /decimal integer/],
  ];
  for (const [name, hocr, message] of BAD_HOCR) {
    it(`hOCR rejects ${name}`, () => expectMarkupError(() => parseHocr(hocr), message));
  }

  it('hOCR accepts decimal values inside the bounds', () => {
    const parsed = parseHocr(
      page('bbox 0 0 1000000 1000000; ppageno 7', line('bbox 0 0 500 20; baseline -0.004 -7; x_size 42.5; x_descenders 10.25', 'bbox 0 0 5 5; x_wconf 96.5'))
    );
    expect(parsed.lineBlocks?.[0].baseline).toEqual({ x0: 0, y0: 13, x1: 500, y1: 11 });
    expect(parsed.lineBlocks?.[0].rowHeight).toBe(42.5);
    expect(parsed.lineBlocks?.[0].words[0].confidence).toBe(0.965);
  });

  const alto = (pageAttributes: string, line = ''): string =>
    `<alto><Layout><Page ${pageAttributes}>${line}</Page></Layout></alto>`;
  const altoLine = (attributes: string): string =>
    `<TextLine HPOS="0" VPOS="0" WIDTH="9" HEIGHT="9"><String CONTENT="x" ${attributes}/></TextLine>`;
  const BAD_ALTO: Array<[string, string, RegExp]> = [
    ['a hexadecimal page width', alto('WIDTH="0x10" HEIGHT="10"'), /decimal number/],
    ['an exponent page height', alto('WIDTH="10" HEIGHT="1e300"'), /decimal number/],
    ['a negative page width', alto('WIDTH="-5" HEIGHT="10"'), /outside 0\.\./],
    ['a zero-area page', alto('WIDTH="0" HEIGHT="10"'), /zero area/],
    ['a page above the coordinate bound', alto('WIDTH="10" HEIGHT="1000001"'), /outside 0\.\./],
    ['a padded number', alto('WIDTH=" 10" HEIGHT="10"'), /decimal number/],
    ['a hexadecimal HPOS', alto('WIDTH="10" HEIGHT="10"', altoLine('HPOS="0x1" VPOS="0" WIDTH="1" HEIGHT="1"')), /decimal number/],
    ['an exponent WIDTH', alto('WIDTH="10" HEIGHT="10"', altoLine('HPOS="0" VPOS="0" WIDTH="1e3" HEIGHT="1"')), /decimal number/],
    ['a negative VPOS', alto('WIDTH="10" HEIGHT="10"', altoLine('HPOS="0" VPOS="-1" WIDTH="1" HEIGHT="1"')), /outside 0\.\./],
    ['a WC above 1', alto('WIDTH="10" HEIGHT="10"', altoLine('HPOS="0" VPOS="0" WIDTH="1" HEIGHT="1" WC="1.5"')), /outside 0\.\.1/],
    [
      'a BASELINE with an exponent',
      alto('WIDTH="10" HEIGHT="10"', '<TextLine HPOS="0" VPOS="0" WIDTH="9" HEIGHT="9" BASELINE="0,1e3 9,5"><String CONTENT="x" HPOS="0" VPOS="0" WIDTH="1" HEIGHT="1"/></TextLine>'),
      /decimal number/,
    ],
  ];
  for (const [name, xml, message] of BAD_ALTO) {
    it(`ALTO rejects ${name}`, () => expectMarkupError(() => parseAlto(xml), message));
  }
});
