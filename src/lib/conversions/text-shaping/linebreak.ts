import { EngineUnavailableError } from '../../types';
import { SHAPE_MAX_PARAGRAPH_CODEPOINTS } from './limits';

/**
 * Line break opportunities. UAX #14 gives the opportunities of scripts that separate words with spaces or break at
 * any character; Thai, Lao, Khmer and Myanmar write words without spaces, so their opportunities come from the
 * dictionary word breaker of the ICU data that ships with the runtime (Intl.Segmenter).
 */

export interface BreakOpportunity {
  /** UTF-16 offset where a new line may start. */
  readonly offset: number;
  /** A line must end here (UAX #14 mandatory break). */
  readonly required: boolean;
}

interface LineBreakerResult {
  position: number;
  required: boolean;
}

interface LineBreakerInstance {
  nextBreak(): LineBreakerResult | null;
}

type LineBreakerConstructor = new (text: string) => LineBreakerInstance;

// linebreak ships without type declarations; it implements UAX #14 and is the breaker pdfkit itself uses.
const LineBreaker: LineBreakerConstructor = require('linebreak');

/** Words of these scripts are found with a dictionary, as [script pattern, BCP 47 language of the dictionary]. */
const DICTIONARY_SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\p{Script=Thai}/u, 'th'],
  [/\p{Script=Lao}/u, 'lo'],
  [/\p{Script=Khmer}/u, 'km'],
  [/\p{Script=Myanmar}/u, 'my'],
];
const DICTIONARY_SCRIPT_RUN = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]+/gu;
/** A phrase every dictionary must split into several words; a runtime without the data returns it whole. */
const DICTIONARY_PROBES: ReadonlyMap<string, string> = new Map([
  ['th', 'สวัสดีชาวโลก'],
  ['lo', 'ສະບາຍດີໂລກ'],
  ['km', 'សួស្តីពិភពលោក'],
  ['my', 'မင်္ဂလာပါကမ္ဘာ'],
]);

const segmenters = new Map<string, Intl.Segmenter>();

function dictionarySegmenter(language: string): Intl.Segmenter {
  const cached = segmenters.get(language);
  if (cached) return cached;
  if (typeof Intl.Segmenter !== 'function') {
    throw new EngineUnavailableError('icu-word-break', `This runtime has no Intl.Segmenter, which is needed to break ${language} text into words`);
  }
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' });
  const probe = DICTIONARY_PROBES.get(language) ?? '';
  if ([...segmenter.segment(probe)].length < 2) {
    throw new EngineUnavailableError(
      'icu-word-break',
      `This runtime has no ICU word dictionary for '${language}'; text in this script cannot be broken into lines`
    );
  }
  segmenters.set(language, segmenter);
  return segmenter;
}

function dictionaryLanguage(codePointText: string): string {
  for (const [pattern, language] of DICTIONARY_SCRIPTS) {
    if (pattern.test(codePointText)) return language;
  }
  return 'th';
}

/**
 * Break opportunities of one paragraph in ascending order, without the end of the text. Throws
 * EngineUnavailableError (503) when the paragraph has Thai, Lao, Khmer or Myanmar text and the runtime has no
 * word dictionary for it.
 */
export function breakOpportunities(text: string): BreakOpportunity[] {
  if (text.length > SHAPE_MAX_PARAGRAPH_CODEPOINTS * 2) {
    throw new RangeError('breakOpportunities() takes a paragraph already limited by itemizeParagraph()');
  }
  const required = new Set<number>();
  const offsets = new Set<number>();
  const breaker = new LineBreaker(text);
  for (let result = breaker.nextBreak(); result !== null; result = breaker.nextBreak()) {
    if (result.position >= text.length) continue;
    offsets.add(result.position);
    if (result.required) required.add(result.position);
  }
  for (const match of text.matchAll(DICTIONARY_SCRIPT_RUN)) {
    const base = match.index ?? 0;
    const language = dictionaryLanguage(String.fromCodePoint(match[0].codePointAt(0) as number));
    for (const word of dictionarySegmenter(language).segment(match[0])) {
      if (word.index > 0) offsets.add(base + word.index);
    }
  }
  return Array.from(offsets)
    .sort((a, b) => a - b)
    .map((offset) => ({ offset, required: required.has(offset) }));
}
