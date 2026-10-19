import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { withConversionWarnings } from '../src/lib/conversions/conversion-warnings';
import { documentToDocx } from '../src/lib/conversions/document-model/docx';
import { documentToEpub } from '../src/lib/conversions/document-model/epub';
import { documentToOdt } from '../src/lib/conversions/document-model/odt';
import { plainTextModel } from '../src/lib/conversions/document-model/plain';
import type { ConversionResult } from '../src/lib/types';
import { docxWords, epubWords, odtWords, pageWords, wordsNotKept } from './helpers/document-words';
import { runEpubcheck } from './helpers/epubcheck';
import { oracleTest } from './helpers/oracle-test';
import { requireRealworldSample } from './helpers/realworld-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { xmlWellFormed, xpathString } from './helpers/xml-oracle';

/**
 * Text with a code point XML 1.0 cannot carry is written without it, and the document is not refused (policy 55):
 * a line tabulation or form feed becomes a line feed, any other control code (U+0000 to U+001F other than tab, line
 * feed and carriage return) is dropped, and a lone surrogate, U+FFFE or U+FFFF becomes U+FFFD, reported in one line
 * for all lone surrogates and one each for U+FFFE and U+FFFF. Before, the Word, ODF and EPUB writers
 * refused the document: three saved pages of the real-world sample (govdocs1) hold U+001A at the end of the file (a DOS
 * end-of-file mark), one holds six U+0000 and two hold U+000C, and each of them converted to PDF, Markdown and text.
 *
 * Oracles: xmllint for every XML part of the package, the saxes and parse5 readers of tests/helpers/document-words.ts
 * for the words, and LibreOffice reading the Word and ODF documents.
 */

const WRITERS = {
  docx: (text: string) => documentToDocx(plainTextModel(text)),
  odt: (text: string) => documentToOdt(plainTextModel(text), { title: 'Controls' }),
  epub: (text: string) => documentToEpub(plainTextModel(text), { title: 'Controls' }),
} as const;
const TARGETS = ['docx', 'odt', 'epub'] as const;
const XML_PART = /\.(xml|xhtml|opf|ncx|rels)$/;
const C0_CONTROLS_DROPPED = [...Array.from({ length: 9 }, (_, code) => code), ...Array.from({ length: 18 }, (_, offset) => 0x0e + offset)];

async function malformedParts(archive: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(archive);
  const bad: string[] = [];
  for (const name of Object.keys(zip.files).filter((entry) => XML_PART.test(entry))) {
    const result = xmlWellFormed(await (zip.file(name) as JSZip.JSZipObject).async('string'));
    if (!result.ok) bad.push(`${name}: ${result.stderr.split('\n')[0]}`);
  }
  return bad;
}

function resultOf(buffer: Buffer): ConversionResult {
  return { buffer, mimeType: 'application/octet-stream', filename: 'out', size: buffer.length };
}

describe('writers given text with code points XML 1.0 cannot carry', () => {
  for (const target of TARGETS) {
    it(`drops every control code and writes a well-formed ${target}`, async () => {
      const controls = C0_CONTROLS_DROPPED.map((code) => String.fromCharCode(code)).join('');
      const archive = await WRITERS[target](`before${controls}after\n\nsecond${String.fromCharCode(0x1a)}paragraph`);
      expect(await malformedParts(archive)).toEqual([]);
      const read = { docx: docxWords, odt: odtWords, epub: epubWords }[target];
      expect(await read(archive)).toContain('beforeafter');
      expect(await read(archive)).toContain('secondparagraph');
    });

    it(`writes a line tabulation and a form feed in the ${target} as line breaks that keep the words apart`, async () => {
      const archive = await WRITERS[target]('end of page.\fNext page\vline');
      expect(await malformedParts(archive)).toEqual([]);
      expect(await { docx: docxWords, odt: odtWords, epub: epubWords }[target](archive)).toEqual(['end', 'of', 'page', 'Next', 'page', 'line']);
    });

    it(`keeps tab, line feed and carriage return in the ${target}`, async () => {
      const archive = await WRITERS[target]('one\ttwo\r\nthree');
      expect(await malformedParts(archive)).toEqual([]);
      expect(await { docx: docxWords, odt: odtWords, epub: epubWords }[target](archive)).toEqual(['one', 'two', 'three']);
    });

    it(`replaces lone surrogates, U+FFFE and U+FFFF in the ${target} with U+FFFD in at most three warning lines`, async () => {
      const text = 'a\ud800b \udbff \ud800 c￾d￾￿e\udc00f';
      const result = await withConversionWarnings(async () => resultOf(await WRITERS[target](text)));
      expect(await malformedParts(result.buffer)).toEqual([]);
      expect(result.metadata?.warnings).toEqual([
        'Replaced a lone surrogate with U+FFFD: XML 1.0 cannot carry this code point (a lone surrogate or a noncharacter).',
        'Replaced U+FFFE with U+FFFD: XML 1.0 cannot carry this code point (a lone surrogate or a noncharacter).',
        'Replaced U+FFFF with U+FFFD: XML 1.0 cannot carry this code point (a lone surrogate or a noncharacter).',
      ]);
    });
  }

  it('writes the U+FFFD for each replaced code point, and a pair of surrogates as the one character it is', async () => {
    const docx = await WRITERS.docx('x\ud800y\u{1f600}z￾');
    const text = await (await JSZip.loadAsync(docx)).file('word/document.xml')?.async('string');
    expect(xpathString(text as string, "string(//*[local-name()='t'])")).toBe('x�y\u{1f600}z�');
  });
});

describe('an HTML page with control codes in its title, headings, cells, list items, links and preformatted text', () => {
  const sub = String.fromCharCode(0x1a);
  const page = Buffer.from(
    `<html><head><title>Ti${sub}tle</title></head><body><h1>Head${sub}ing one</h1><p>para${sub}graph with a <a href="https://example.com/">li${sub}nk</a></p>` +
      `<ul><li>list${sub}item</li></ul><table><tr><td>ce${sub}ll</td></tr></table><pre>pre${sub}formatted</pre>` +
      `<img alt="al${sub}t" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></body></html>`
  );
  const expected = ['Heading', 'one', 'paragraph', 'with', 'link', 'listitem', 'cell', 'preformatted'];

  for (const target of TARGETS) {
    it(`converts to a well-formed ${target} with the text on either side of the code`, async () => {
      const result = await convertFile(page, 'html', target, {}, 'page.html');
      expect(await malformedParts(result.buffer)).toEqual([]);
      const words = await { docx: docxWords, odt: odtWords, epub: epubWords }[target](result.buffer);
      expect(wordsNotKept(expected, words)).toEqual([]);
    });
  }
});

describe('pages of the real-world corpus with control codes in them', () => {
  // The code each page holds, read from its bytes: U+001A after the closing tag, six U+0000 in a list item, U+000C in preformatted text.
  // The page with U+001A is a TEI transcription whose markup the reader does not follow to the last word (header elements in the body); for it the last 200 words, which the code follows, are checked.
  const pages: Array<[string, string, number | undefined]> = [
    ['govdocs1-001417.html', 'U+001A at the end of the file', 200],
    ['govdocs1-001847.html', 'U+001A at the end of the file', undefined],
    ['govdocs1-000783.html', 'six U+0000 after a list item', undefined],
    ['govdocs1-000448.html', 'U+000C between two lines', undefined],
    ['govdocs1-001541.html', 'U+000C inside indentation', undefined],
  ];

  for (const [id, what, lastWords] of pages) {
    for (const target of TARGETS) {
      it(`${id} (${what}) converts to a well-formed ${target} that keeps the text of the page`, async (ctx) => {
        const sample = await requireRealworldSample(ctx, id);
        const result = await convertFile(sample.bytes, 'html', target, {}, id);
        expect(await malformedParts(result.buffer)).toEqual([]);
        const all = pageWords(new TextDecoder('windows-1252').decode(sample.bytes));
        const expected = lastWords === undefined ? all : all.slice(-lastWords);
        expect(expected.length).toBeGreaterThanOrEqual(lastWords ?? 50);
        const words = await { docx: docxWords, odt: odtWords, epub: epubWords }[target](result.buffer);
        expect(wordsNotKept(expected, words)).toEqual([]);
      });
    }
  }

  oracleTest(
    'the EPUB made from the page with six U+0000 passes EPUBCheck with no error',
    ['epubcheck'],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'govdocs1-000783.html');
      const report = runEpubcheck((await convertFile(sample.bytes, 'html', 'epub', {}, 'govdocs1-000783.html')).buffer);
      expect(report.messages.filter((message) => message.severity === 'ERROR' || message.severity === 'FATAL')).toEqual([]);
    },
    240_000
  );

  oracleTest(
    'LibreOffice opens the Word and ODF documents made from the page with U+001A and reads its last paragraph',
    ['soffice'],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'govdocs1-001417.html');
      const closing = 'firing by the Marines was all subsequent to the obtaining possession of the swivel';
      for (const target of ['docx', 'odt'] as const) {
        const converted = await convertFile(sample.bytes, 'html', target, {}, 'govdocs1-001417.html');
        const text = sofficeConvert(converted.buffer, `page.${target}`, 'txt:Text', (output) => output.read().toString('utf-8'));
        expect(text.replace(/\s+/g, ' ')).toContain(closing);
      }
    },
    300_000
  );
});
