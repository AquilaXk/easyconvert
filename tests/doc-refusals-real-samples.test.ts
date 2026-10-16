import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { corpusSample } from './helpers/corpus-sample';
import { sofficeConvert } from './helpers/soffice-convert';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real Word documents of the government corpus (bench/realworld/manifest.json, source govdocs1-listed) that the in-process
 * Word reader refused with a LegacyOfficeFormatError although the office suite reads them (#783, found by the regression
 * corpus trial of #787). Two are read now: the streams of an embedded object no longer replace the document's own, and a
 * text piece that runs on past the end of the main story no longer breaks the piece table check. The others are Word 6
 * and Macintosh Word 5 files that only the office suite reads; the reader's refusal makes the worker try the office suite.
 * The oracle is the office suite's own text export of the same file.
 */

const toolsMissing = skipWithoutTools('soffice');
const CONVERSION_TIMEOUT_MS = 300_000;
const MIN_WORD_LENGTH = 4;
/** Share of the office suite's words that the output may lack (page headers and footers are laid out differently). */
const MAX_MISSING_SHARE = 0.05;
const TARGETS = ['txt', 'html', 'md'] as const;

const DOCUMENTS: ReadonlyArray<{ id: string; why: string }> = [
  { id: 'govdocs1-061894.doc', why: 'embedded Word and Visio objects keep their own WordDocument and 1Table streams' },
  { id: 'govdocs1-408271.doc', why: 'the piece that holds the end of the main story goes on into the footnote story' },
  { id: 'govdocs1-233541.doc', why: 'a Word 6 document written on a Macintosh, which the office suite alone reads' },
  { id: 'govdocs1-251996.doc', why: 'a Word 5.0 for Macintosh file, which is not an OLE2 compound file' },
];

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

function stripMarkup(markup: string): string {
  return markup.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

describe.skipIf(toolsMissing)('Word documents the in-process reader refused', () => {
  for (const { id, why } of DOCUMENTS) {
    it(
      `${id} (${why}) converts to text, HTML and Markdown with the words the office suite shows`,
      async (ctx) => {
        const doc = await corpusSample(id);
        // skip-ok: corpusSample returns null only outside ORACLE_STRICT_MODE; under strict mode it throws.
        if (!doc) return ctx.skip();
        const reference = new Set(sofficeConvert(doc, id, 'txt:Text (encoded):UTF8', (output) => wordsOf(output.read().toString('utf-8'))));
        expect(reference.size).toBeGreaterThan(0);
        for (const target of TARGETS) {
          const result = await dispatchConversion(doc, 'doc', target, {}, id);
          const text = target === 'html' ? stripMarkup(result.buffer.toString('utf-8')) : result.buffer.toString('utf-8');
          const have = new Set(wordsOf(text));
          const missing = [...reference].filter((word) => !have.has(word));
          expect({ target, missing: missing.slice(0, 10), withinLimit: missing.length <= reference.size * MAX_MISSING_SHARE }).toEqual({
            target,
            missing: missing.slice(0, 10),
            withinLimit: true,
          });
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});
