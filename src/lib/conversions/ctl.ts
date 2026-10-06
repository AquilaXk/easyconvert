import { ComplexScriptRequiresNativeEngineError } from '../types';

export { ComplexScriptRequiresNativeEngineError };

/**
 * Unicode scripts requiring Complex Text Layout (CTL), bidirectional (Bidi) text shaping,
 * OpenType GSUB/GPOS tables, or HarfBuzz shaping that cannot be reliably rendered by
 * pure-TypeScript PDF engines without native OpenType shaping engines.
 */
export const CTL_SCRIPT_DEFINITIONS: Array<{ name: string; regex: RegExp }> = [
  { name: 'Arabic', regex: /\p{Script=Arabic}/u },
  { name: 'Hebrew', regex: /\p{Script=Hebrew}/u },
  { name: 'Thai', regex: /\p{Script=Thai}/u },
  { name: 'Devanagari', regex: /\p{Script=Devanagari}/u },
  { name: 'Bengali', regex: /\p{Script=Bengali}/u },
  { name: 'Tamil', regex: /\p{Script=Tamil}/u },
  { name: 'Telugu', regex: /\p{Script=Telugu}/u },
  { name: 'Kannada', regex: /\p{Script=Kannada}/u },
  { name: 'Malayalam', regex: /\p{Script=Malayalam}/u },
  { name: 'Gurmukhi', regex: /\p{Script=Gurmukhi}/u },
  { name: 'Gujarati', regex: /\p{Script=Gujarati}/u },
  { name: 'Oriya', regex: /\p{Script=Oriya}/u },
  { name: 'Sinhala', regex: /\p{Script=Sinhala}/u },
  { name: 'Khmer', regex: /\p{Script=Khmer}/u },
  { name: 'Lao', regex: /\p{Script=Lao}/u },
  { name: 'Myanmar', regex: /\p{Script=Myanmar}/u },
  { name: 'Tibetan', regex: /\p{Script=Tibetan}/u },
  { name: 'Syriac', regex: /\p{Script=Syriac}/u },
  { name: 'Thaana', regex: /\p{Script=Thaana}/u },
];

export const COMPLEX_SCRIPT_REGEX = new RegExp(
  CTL_SCRIPT_DEFINITIONS.map((s) => `\\p{Script=${s.name}}`).join('|'),
  'u'
);

/**
 * Returns true if the text contains characters from any complex text layout (CTL)
 * or right-to-left (RTL) script.
 */
export function hasComplexTextScript(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return COMPLEX_SCRIPT_REGEX.test(text);
}

/** Han, Hangul, Kana and Bopomofo: the scripts of Chinese, Japanese and Korean text. */
export const CJK_SCRIPT_REGEX = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/u;

/**
 * Returns true if the text contains Chinese, Japanese or Korean characters.
 */
export function hasCjkScript(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return CJK_SCRIPT_REGEX.test(text);
}

/**
 * Returns the names of all complex scripts found in the input text.
 */
export function getDetectedComplexScripts(text: string): string[] {
  if (!text || typeof text !== 'string') return [];
  const detected: string[] = [];
  for (const s of CTL_SCRIPT_DEFINITIONS) {
    if (s.regex.test(text)) {
      detected.push(s.name);
    }
  }
  return detected;
}

/**
 * Asserts that the input text does not contain complex text scripts.
 * Throws ComplexScriptRequiresNativeEngineError if any CTL/RTL scripts are found.
 */
export function assertNoComplexScript(text: string, context = 'PDF conversion'): void {
  const scripts = getDetectedComplexScripts(text);
  if (scripts.length > 0) {
    throw new ComplexScriptRequiresNativeEngineError(
      `${context} contains complex or bidirectional script (${scripts.join(', ')}). High-fidelity rendering requires the native LibreOffice engine.`
    );
  }
}
