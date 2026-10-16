import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { requireRealworldSample } from './helpers/realworld-sample';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { xpsGlyphText } from './helpers/xps-glyphs';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real Word documents of the government corpus (bench/realworld/manifest.json, source govdocs1-listed) that the in-process
 * Word reader refused with a LegacyOfficeFormatError although the office suite reads them (#783, found by the regression
 * corpus trial of #787). Two are read now: the streams of an embedded object no longer replace the document's own, and a
 * text piece that runs on past the end of the main story no longer breaks the piece table check. The others are Word 6
 * and Macintosh Word 5 files that only the office suite reads; the reader's refusal makes the worker try the office suite.
 * Two oracles read the result, and neither is the office suite's text export that the converter itself calls: the words of the
 * PDF the office suite prints of the same file, read by pdftotext, and phrases from each document's first pages pinned as
 * literals (read from that PDF with pdftotext and compared with the pages of the document by eye, not taken from the converter).
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftotext');
const CONVERSION_TIMEOUT_MS = 300_000;
const MIN_WORD_LENGTH = 4;
/** Share of the words of the printed PDF that the output may lack (page headers, footers and numbers are laid out differently). */
const MAX_MISSING_SHARE = 0.05;
const TARGETS = ['txt', 'html', 'md', 'xps'] as const;

const DOCUMENTS: ReadonlyArray<{ id: string; why: string; phrases: readonly string[]; maxMissingShare?: number }> = [
  {
    id: 'govdocs1-061894.doc',
    why: 'embedded Word and Visio objects keep their own WordDocument and 1Table streams',
    phrases: ['doe project execution plan', 'run iib cdf detector project', 'fermi national accelerator laboratory'],
  },
  {
    id: 'govdocs1-408271.doc',
    why: 'the piece that holds the end of the main story goes on into the footnote story',
    phrases: ['observation of clouds and precipitation', 'through spaceborne doppler radar', 'designing a system to improve current atmospheric dynamics models'],
  },
  {
    id: 'govdocs1-233541.doc',
    why: 'a Word 6 document written on a Macintosh, which the office suite alone reads',
    phrases: ['intellectual property and the national information infrastructure', 'the report of the working group on intellectual property rights', 'bruce a lehman'],
    // The printed document holds the footnotes of this report at the foot of its pages (22.7% of its words, as in "See supra note 11"); the text
    // export of the office suite, and so the text target, leaves footnotes out, as the reader of Word text does for the main story.
    maxMissingShare: 0.25,
  },
  {
    id: 'govdocs1-251996.doc',
    why: 'a Word 5.0 for Macintosh file, which is not an OLE2 compound file',
    phrases: ['geologic map of the borealis region', 'maurice j grolier and joseph m boyce', 'prepared for the national aeronautics and space administration'],
  },
];

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

/** The text in lower case with every run of characters that are no letters or digits as one space. */
function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function stripMarkup(markup: string): string {
  return markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

async function textOf(output: Buffer, target: (typeof TARGETS)[number]): Promise<string> {
  if (target === 'xps') return xpsGlyphText(output);
  return target === 'html' ? stripMarkup(output.toString('utf-8')) : output.toString('utf-8');
}

describe.skipIf(toolsMissing)('Word documents the in-process reader refused', () => {
  for (const { id, why, phrases, maxMissingShare = MAX_MISSING_SHARE } of DOCUMENTS) {
    it(
      `${id} (${why}) converts to text, HTML and Markdown with the words of the printed document`,
      async (ctx) => {
        const { bytes: doc } = await requireRealworldSample(ctx, id);
        const reference = new Set(sofficeConvert(doc, id, 'pdf', (output) => wordsOf(extractTextWithExternalPdftotext(output.read()) ?? '')));
        expect(reference.size).toBeGreaterThan(0);
        for (const target of TARGETS) {
          const result = await dispatchConversion(doc, 'doc', target, {}, id);
          if (target === 'txt') expect(result.buffer.subarray(0, 3), 'a text export starts with a UTF-8 byte order mark').not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
          const text = await textOf(result.buffer, target);
          const have = new Set(wordsOf(text));
          const missing = [...reference].filter((word) => !have.has(word));
          expect({ target, missing: missing.slice(0, 10), withinLimit: missing.length <= reference.size * maxMissingShare }).toEqual({
            target,
            missing: missing.slice(0, 10),
            withinLimit: true,
          });
          const normalized = normalizedText(text);
          expect({ target, missingPhrases: phrases.filter((phrase) => !normalized.includes(phrase)) }).toEqual({ target, missingPhrases: [] });
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});
