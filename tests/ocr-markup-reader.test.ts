import { describe, expect, it } from 'vitest';
import {
  OCR_MARKUP_MAX_ATTRIBUTES,
  OCR_MARKUP_MAX_CHARS,
  OCR_MARKUP_MAX_DEPTH,
  OCR_MARKUP_MAX_ELEMENTS,
  OCR_MARKUP_MAX_NAME_CHARS,
  OcrMarkupError,
  readMarkup,
  unescapeXml,
  type MarkupHandler,
} from '../src/lib/conversions/ocr-markup';
import { ConversionFailedError } from '../src/lib/types';

/** Records every event as a short string so a document's reading can be compared with a hand-written list. */
function events(xml: string): string[] {
  const log: string[] = [];
  const handler: MarkupHandler = {
    open: (name, attributes, depth) => {
      const attrs = Object.entries(attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
      log.push(`<${name}@${depth}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>`);
    },
    text: (text) => log.push(`text:${JSON.stringify(text)}`),
    close: (name, depth) => log.push(`</${name}@${depth}>`),
  };
  readMarkup(xml, handler);
  return log;
}

function expectMarkupError(xml: string, message: RegExp): void {
  let thrown: unknown;
  try {
    readMarkup(xml, { open: () => {}, text: () => {}, close: () => {} });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(OcrMarkupError);
  expect((thrown as OcrMarkupError).message).toMatch(message);
}

describe('readMarkup', () => {
  it('reports elements, decoded attributes and text, dropping prefixes, comments and processing instructions', () => {
    const xml =
      '﻿<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">' +
      "<!-- note --><h:root xmlns:h='urn:x' a=\"1 &lt; 2\" b='say &quot;hi&quot;'>one &amp; two<?pi data?><h:leaf  c = 'x\ty\nz' /><![CDATA[<raw & text>]]>&#65;&#x42;&#x1F600;</h:root>\n";
    expect(events(xml)).toEqual([
      '<root@1 xmlns:h="urn:x" a="1 < 2" b="say \\"hi\\"">',
      'text:"one & two"',
      '<leaf@2 c="x y z">',
      '</leaf@2>',
      'text:"<raw & text>"',
      'text:"AB\u{1F600}"',
      '</root@1>',
    ]);
  });

  it('decodes character references that are valid XML characters and leaves unknown ones alone when lenient', () => {
    expect(unescapeXml('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#x41;&#66;')).toBe('a & b <c> "d" \'e\' AB');
    expect(unescapeXml('&nbsp; &#0; &#xD800; &amp')).toBe('&nbsp; &#0; &#xD800; &amp');
    expect(unescapeXml('')).toBe('');
    // A long run of ampersands is scanned in linear time and returned unchanged.
    const run = '&'.repeat(1_000_000);
    expect(unescapeXml(run)).toBe(run);
  });

  const MALFORMED: Array<[string, string, RegExp]> = [
    ['an empty document', '', /no root element/],
    ['text only', 'hello', /outside the root/],
    ['a mismatched end tag', '<a><b></a></b>', /does not match <b>/],
    ['an unclosed element', '<a><b></b>', /<a> is not closed/],
    ['an end tag without a start', '</a>', /unexpected end tag/],
    ['two roots', '<a/><b/>', /more than one root/],
    ['text after the root', '<a/>tail', /outside the root/],
    ['an unquoted attribute', '<a b=c/>', /not quoted/],
    ['an attribute without a value', '<a b/>', /no value/],
    ['a duplicated attribute', '<a b="1" b="2"/>', /duplicate attribute b/],
    ['attributes without white space between them', '<a b="1"c="2"/>', /separated by white space/],
    ['a < inside an attribute value', '<a b="<"/>', /contains </],
    ['an unterminated attribute value', '<a b="1/>', /not terminated/],
    ['an unterminated start tag', '<a b="1"', /unterminated start tag/],
    ['an undefined entity', '<a>&nbsp;</a>', /unknown or malformed character reference/],
    ['a reference without a semicolon', '<a>&amp</a>', /unknown or malformed character reference/],
    ['a NUL character reference', '<a>&#0;</a>', /unknown or malformed character reference/],
    ['a surrogate character reference', '<a>&#xD800;</a>', /unknown or malformed character reference/],
    ['an out-of-range character reference', '<a>&#x110000;</a>', /unknown or malformed character reference/],
    ['an undefined entity in an attribute', '<a b="&bogus;"/>', /unknown or malformed character reference/],
    ['an unterminated comment', '<a><!-- x</a>', /unterminated comment/],
    ['an unterminated CDATA section', '<a><![CDATA[ x</a>', /unterminated CDATA/],
    ['CDATA outside the root', '<![CDATA[x]]><a/>', /CDATA outside/],
    ['an unterminated processing instruction', '<a><?x</a>', /unterminated processing instruction/],
    ['an unsupported markup declaration', '<a><!ELEMENT a ANY></a>', /unsupported markup declaration/],
    ['an element name starting with a digit', '<1a/>', /expected element name/],
    ['a DOCTYPE after the root', '<a/><!DOCTYPE a>', /misplaced DOCTYPE/],
  ];
  for (const [name, xml, message] of MALFORMED) {
    it(`rejects ${name}`, () => expectMarkupError(xml, message));
  }

  it('refuses a DOCTYPE internal subset, so no entity can be declared or expanded', () => {
    const bomb =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]><lolz>&b;</lolz>';
    expectMarkupError(bomb, /internal subset is not supported/);
    expectMarkupError('<!DOCTYPE x SYSTEM "file:///etc/passwd" [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>', /internal subset/);
    expectMarkupError('<!DOCTYPE html PUBLIC "-//x" "http://example.invalid/x.dtd"', /unterminated DOCTYPE/);
  });

  it('accepts a bracket inside a quoted DOCTYPE identifier', () => {
    expect(events('<!DOCTYPE html SYSTEM "a[b.dtd"><r/>')).toEqual(['<r@1>', '</r@1>']);
  });

  describe('named limits', () => {
    const nested = (depth: number): string => '<a>'.repeat(depth) + '</a>'.repeat(depth);

    it(`accepts nesting of ${OCR_MARKUP_MAX_DEPTH} and rejects one level more`, () => {
      expect(events(nested(OCR_MARKUP_MAX_DEPTH))).toHaveLength(OCR_MARKUP_MAX_DEPTH * 2);
      expectMarkupError(nested(OCR_MARKUP_MAX_DEPTH + 1), new RegExp(`deeper than ${OCR_MARKUP_MAX_DEPTH}`));
    });

    it(`accepts ${OCR_MARKUP_MAX_ATTRIBUTES} attributes and rejects one more`, () => {
      const element = (count: number): string =>
        `<a ${Array.from({ length: count }, (_, i) => `k${i}="v"`).join(' ')}/>`;
      expect(events(element(OCR_MARKUP_MAX_ATTRIBUTES))[0]).toContain(`k${OCR_MARKUP_MAX_ATTRIBUTES - 1}="v"`);
      expectMarkupError(element(OCR_MARKUP_MAX_ATTRIBUTES + 1), new RegExp(`more than ${OCR_MARKUP_MAX_ATTRIBUTES} attributes`));
    });

    it(`accepts names of ${OCR_MARKUP_MAX_NAME_CHARS} characters and rejects one more`, () => {
      const name = 'n'.repeat(OCR_MARKUP_MAX_NAME_CHARS);
      expect(events(`<${name}/>`)).toEqual([`<${name}@1>`, `</${name}@1>`]);
      expectMarkupError(`<${name}n/>`, /name is longer than/);
    });

    it(`stops after ${OCR_MARKUP_MAX_ELEMENTS} elements`, () => {
      let opened = 0;
      const reader = (xml: string): void =>
        readMarkup(xml, {
          open: () => {
            opened++;
          },
          text: () => {},
          close: () => {},
        });
      reader(`<r>${'<a/>'.repeat(OCR_MARKUP_MAX_ELEMENTS - 1)}</r>`);
      expect(opened).toBe(OCR_MARKUP_MAX_ELEMENTS);
      expect(() => reader(`<r>${'<a/>'.repeat(OCR_MARKUP_MAX_ELEMENTS)}</r>`)).toThrow(OcrMarkupError);
    });

    it(`rejects a document longer than ${OCR_MARKUP_MAX_CHARS} characters before reading it`, () => {
      expectMarkupError('a'.repeat(OCR_MARKUP_MAX_CHARS + 1), /larger than/);
    });
  });

  it('throws typed errors that the API maps to HTTP 400', () => {
    let thrown: unknown;
    try {
      readMarkup('<a>', { open: () => {}, text: () => {}, close: () => {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConversionFailedError);
    expect(thrown).toMatchObject({ name: 'OcrMarkupError', status: 400 });
  });
});
