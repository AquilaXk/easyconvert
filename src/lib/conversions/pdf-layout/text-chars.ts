/** Character classes the layout needs; all tests are on a single code point or a string's ends. */

const RIGHT_TO_LEFT_LETTER = /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
/** Han and the two kana: scripts written without spaces between words. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const THAI_LIKE = /[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const UPPERCASE = /\p{Lu}/u;
const LOWERCASE = /\p{Ll}/u;
const WHITESPACE = /\s/u;
/** Closing and opening CJK punctuation take no space on their open side. */
const CJK_PUNCTUATION = /[　-〿＀-￯]/u;

export function firstChar(text: string): string {
  return String.fromCodePoint(text.codePointAt(0) ?? 0);
}

const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** The last code point of the text; reads at most two UTF-16 units, so it costs the same whatever the length. */
export function lastChar(text: string): string {
  if (text.length === 0) return '';
  const unit = text.charCodeAt(text.length - 1);
  const isLowSurrogate = unit >= LOW_SURROGATE_FIRST && unit <= LOW_SURROGATE_LAST;
  return text.slice(isLowSurrogate && text.length > 1 ? text.length - 2 : text.length - 1);
}

export function isRightToLeftLetter(char: string): boolean {
  return RIGHT_TO_LEFT_LETTER.test(char);
}

export function isLetter(char: string): boolean {
  return LETTER.test(char);
}

export function isDigit(char: string): boolean {
  return DIGIT.test(char);
}

export function isUppercase(char: string): boolean {
  return UPPERCASE.test(char);
}

export function isLowercase(char: string): boolean {
  return LOWERCASE.test(char);
}

export function isWhitespace(char: string): boolean {
  return WHITESPACE.test(char);
}

/** Han or kana: a line may break between two of these without a space. */
export function isUnspacedScript(char: string): boolean {
  return UNSPACED_SCRIPT.test(char) || CJK_PUNCTUATION.test(char);
}

export function isHangul(char: string): boolean {
  return HANGUL.test(char);
}

/** Thai, Lao, Khmer and Myanmar text has no spaces between words; a line break there takes none. */
export function isThaiLike(char: string): boolean {
  return THAI_LIKE.test(char);
}

/** Strong direction of the letters of a text: positive for right to left, negative for left to right. */
export function directionBalance(text: string): number {
  let balance = 0;
  for (const char of text) {
    if (isRightToLeftLetter(char)) balance++;
    else if (isLetter(char)) balance--;
  }
  return balance;
}

/**
 * Whether a line break between two pieces of text needs a space: not between two characters of an unspaced script
 * (Han, kana, Thai-like), and not next to white space that is already there.
 */
export function needsSpaceBetween(before: string, after: string): boolean {
  if (before === '' || after === '') return false;
  const left = lastChar(before);
  const right = firstChar(after);
  if (isWhitespace(left) || isWhitespace(right)) return false;
  if (isUnspacedScript(left) && isUnspacedScript(right)) return false;
  if (isThaiLike(left) && isThaiLike(right)) return false;
  // Hangul is written with spaces between words, so a break between two of its words takes one.
  return true;
}
