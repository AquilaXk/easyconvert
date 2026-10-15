import { UnsupportedOptionError } from '../types';
import type { DocumentModel } from './document-model/model';
import { bodyBlocks, blockRuns, walkBlocks } from './document-model/support';
import { inlineText } from './document-model/text';

/**
 * BCP 47 language tags for documents: validating a tag a request or a source names, and recognising the language of
 * text when nothing names it. Detection answers only when the evidence is clear (a script that belongs to one
 * language, or common function words of one Latin-script language well ahead of the others); otherwise it answers
 * nothing, and the caller records the language as undetermined instead of guessing.
 */

const LANGUAGE_TAG = /^([a-zA-Z]{2,3})(?:-([a-zA-Z]{4}))?(?:-([a-zA-Z]{2}|\d{3}))?$/;
/** Words sampled from the start of a text. */
const DETECTION_SAMPLE_WORDS = 20_000;
/** Letters sampled for script counts. */
const DETECTION_SAMPLE_LETTERS = 200_000;
const MIN_FUNCTION_WORD_HITS = 3;
const FUNCTION_WORD_LEAD = 1.5;
const KANA_SHARE = 0.05;
const HANGUL_SHARE = 0.1;
const HAN_SHARE = 0.3;
const SCRIPT_SHARE = 0.3;

/** Returns `tag` in canonical case (`en-US`, `zh-Hant`), or undefined when it is not a language[-script][-region] tag. */
export function normalizeLanguageTag(tag: string): string | undefined {
  const match = LANGUAGE_TAG.exec(tag.trim().replace(/_/g, '-'));
  if (!match) return undefined;
  const [, language, script, region] = match;
  let normalized = language.toLowerCase();
  if (script) normalized += `-${script[0].toUpperCase()}${script.slice(1).toLowerCase()}`;
  if (region) normalized += `-${region.toUpperCase()}`;
  return normalized;
}

const FUNCTION_WORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['en', new Set(['the', 'and', 'of', 'to', 'in', 'is', 'that', 'for', 'with', 'are', 'was', 'this'])],
  ['de', new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'von', 'zu', 'den'])],
  ['fr', new Set(['le', 'la', 'les', 'des', 'et', 'est', 'une', 'dans', 'pour', 'que', 'qui', 'pas'])],
  ['es', new Set(['el', 'los', 'las', 'que', 'una', 'del', 'por', 'con', 'para', 'es', 'se', 'su'])],
  ['it', new Set(['il', 'gli', 'che', 'non', 'una', 'del', 'per', 'con', 'sono', 'della', 'nel', 'di'])],
  ['pt', new Set(['os', 'as', 'que', 'uma', 'para', 'com', 'não', 'do', 'da', 'em', 'dos', 'são'])],
  ['nl', new Set(['de', 'het', 'een', 'en', 'van', 'dat', 'niet', 'met', 'voor', 'zijn', 'ook', 'te'])],
]);

interface ScriptRange {
  readonly pattern: RegExp;
}

const HANGUL: ScriptRange = { pattern: /[ᄀ-ᇿ㄰-㆏가-힯]/g };
const KANA: ScriptRange = { pattern: /[぀-ヿ]/g };
const HAN: ScriptRange = { pattern: /[㐀-䶿一-鿿]/g };
const THAI: ScriptRange = { pattern: /[฀-๿]/g };
const GREEK: ScriptRange = { pattern: /[Ͱ-Ͽ]/g };
const HEBREW: ScriptRange = { pattern: /[֐-׿]/g };
const ARABIC: ScriptRange = { pattern: /[؀-ۿ]/g };
const DEVANAGARI: ScriptRange = { pattern: /[ऀ-ॿ]/g };
const CYRILLIC: ScriptRange = { pattern: /[Ѐ-ӿ]/g };
const LETTER = /\p{L}/gu;
const RUSSIAN_LETTERS = /[ыэъ]/gi;
const UKRAINIAN_LETTERS = /[іїєґ]/gi;

function count(text: string, range: RegExp): number {
  return text.match(range)?.length ?? 0;
}

/** The language `text` is written in when the evidence is clear, otherwise undefined. */
export function detectLanguage(text: string): string | undefined {
  const sample = text.slice(0, DETECTION_SAMPLE_LETTERS);
  const letters = count(sample, LETTER);
  if (letters === 0) return undefined;
  const share = (range: ScriptRange): number => count(sample, range.pattern) / letters;
  if (share(KANA) >= KANA_SHARE) return 'ja';
  if (share(HANGUL) >= HANGUL_SHARE) return 'ko';
  if (share(HAN) >= HAN_SHARE) return 'zh';
  if (share(THAI) >= SCRIPT_SHARE) return 'th';
  if (share(GREEK) >= SCRIPT_SHARE) return 'el';
  if (share(HEBREW) >= SCRIPT_SHARE) return 'he';
  if (share(ARABIC) >= SCRIPT_SHARE) return 'ar';
  if (share(DEVANAGARI) >= SCRIPT_SHARE) return 'hi';
  if (share(CYRILLIC) >= SCRIPT_SHARE) {
    const russian = count(sample, RUSSIAN_LETTERS);
    const ukrainian = count(sample, UKRAINIAN_LETTERS);
    if (russian > ukrainian) return 'ru';
    return ukrainian > russian ? 'uk' : undefined;
  }
  const words = sample.toLowerCase().split(/[^\p{L}]+/u, DETECTION_SAMPLE_WORDS);
  const scores = [...FUNCTION_WORDS].map(([language, set]) => ({ language, hits: words.filter((word) => set.has(word)).length }));
  scores.sort((a, b) => b.hits - a.hits);
  const [best, second] = scores;
  if (best.hits >= MIN_FUNCTION_WORD_HITS && best.hits >= second.hits * FUNCTION_WORD_LEAD) return best.language;
  return undefined;
}

/**
 * The language of a document for targets that record one: the `requested` tag (refused when it is not a BCP 47 tag),
 * else the language the source declares, else the language recognised from the text. Undefined when nothing says.
 */
export function resolveLanguage(model: DocumentModel, requested: string | undefined): string | undefined {
  if (requested !== undefined) {
    const tag = normalizeLanguageTag(requested);
    if (tag === undefined) throw new UnsupportedOptionError(`The language option "${requested}" is not a BCP 47 language tag.`);
    return tag;
  }
  const declared = model.language ? normalizeLanguageTag(model.language) : undefined;
  if (declared) return declared;
  const text: string[] = [];
  walkBlocks(bodyBlocks(model), (block) => {
    for (const runs of blockRuns(block)) text.push(inlineText(runs));
  });
  return detectLanguage(text.join('\n'));
}
