import { OcrLanguageUnavailableError } from '../types';

/**
 * The OCR language table: every language with published Tesseract training data (the tessdata set), keyed by the
 * name of its traineddata file, with the ISO 639-1 code (when the language has one), the ISO 15924 script and the
 * direction text runs in. A request names a language by its traineddata name, its ISO 639-1 or 639-3 code or a
 * BCP 47 tag (`ko`, `kor`, `zh-Hans`, `sr-Latn`), and joins several with `+` (`eng+kor`).
 *
 * The module is pure (no file system, no Node built-ins) so that the browser tier checks a request against the
 * same table the server does; which of these languages have their data installed is read from disk on the server
 * (ocr-language-data.ts). `osd` (orientation and script detection data) is not a language and is not listed.
 */

export type OcrTextDirection = 'ltr' | 'rtl' | 'ttb';

export interface OcrLanguage {
  /** Name of the traineddata file without its extension: what is handed to the engine. */
  readonly traineddata: string;
  /** English name of the language. */
  readonly name: string;
  /** ISO 639-1 code, when the language has one; the short code the languages endpoint reports. */
  readonly iso639_1?: string;
  /** ISO 15924 script code of the writing system the data reads. */
  readonly script: string;
  /** Direction the text runs in; `ttb` is data trained on vertical lines. */
  readonly direction: OcrTextDirection;
  /** Further names the language is requested by: BCP 47 tags with a script or region, and earlier spellings. */
  readonly aliases: readonly string[];
}

/** Most languages one request may join with `+`; each is loaded into the engine, so the count bounds memory. */
export const OCR_MAX_LANGUAGES_PER_REQUEST = 4;
/** The request value that means "no language given": English. */
export const OCR_AUTO_LANGUAGE = 'auto';
/** Language `auto` stands for. */
export const OCR_AUTO_TRAINEDDATA = 'eng';
const LANGUAGE_SEPARATOR = '+';
/** A request longer than this is not a language list; it is refused before it is split. */
const MAX_LANGUAGE_REQUEST_CHARS = 128;

type Row = readonly [traineddata: string, name: string, iso639_1: string, script: string, direction?: OcrTextDirection, aliases?: readonly string[]];

const NO_ISO_639_1 = '';
const LATIN = 'Latn';
const CYRILLIC = 'Cyrl';
const ARABIC = 'Arab';
const DEVANAGARI = 'Deva';
const HEBREW = 'Hebr';

/** Rows are written in the order of the tessdata file names. */
const ROWS: readonly Row[] = [
  ['afr', 'Afrikaans', 'af', LATIN],
  ['amh', 'Amharic', 'am', 'Ethi'],
  ['ara', 'Arabic', 'ar', ARABIC, 'rtl'],
  ['asm', 'Assamese', 'as', 'Beng'],
  ['aze', 'Azerbaijani', 'az', LATIN, 'ltr', ['az-latn']],
  ['aze_cyrl', 'Azerbaijani (Cyrillic)', NO_ISO_639_1, CYRILLIC, 'ltr', ['az-cyrl']],
  ['bel', 'Belarusian', 'be', CYRILLIC],
  ['ben', 'Bengali', 'bn', 'Beng'],
  ['bod', 'Tibetan', 'bo', 'Tibt'],
  ['bos', 'Bosnian', 'bs', LATIN],
  ['bre', 'Breton', 'br', LATIN],
  ['bul', 'Bulgarian', 'bg', CYRILLIC],
  ['cat', 'Catalan', 'ca', LATIN],
  ['ceb', 'Cebuano', NO_ISO_639_1, LATIN],
  ['ces', 'Czech', 'cs', LATIN],
  ['chi_sim', 'Chinese (Simplified)', 'zh', 'Hans', 'ltr', ['zh-hans', 'zh-cn', 'zh-sg']],
  ['chi_sim_vert', 'Chinese (Simplified, vertical)', NO_ISO_639_1, 'Hans', 'ttb', ['zh-vert', 'zh-sim-vert', 'zh-hans-vert']],
  ['chi_tra', 'Chinese (Traditional)', NO_ISO_639_1, 'Hant', 'ltr', ['zh-tra', 'zh-hant', 'zh-tw', 'zh-hk']],
  ['chi_tra_vert', 'Chinese (Traditional, vertical)', NO_ISO_639_1, 'Hant', 'ttb', ['zh-tra-vert', 'zh-hant-vert']],
  ['chr', 'Cherokee', NO_ISO_639_1, 'Cher'],
  ['cos', 'Corsican', 'co', LATIN],
  ['cym', 'Welsh', 'cy', LATIN],
  ['dan', 'Danish', 'da', LATIN],
  ['deu', 'German', 'de', LATIN],
  ['div', 'Dhivehi', 'dv', 'Thaa', 'rtl'],
  ['dzo', 'Dzongkha', 'dz', 'Tibt'],
  ['ell', 'Greek', 'el', 'Grek'],
  ['eng', 'English', 'en', LATIN],
  ['enm', 'Middle English', NO_ISO_639_1, LATIN],
  ['epo', 'Esperanto', 'eo', LATIN],
  ['equ', 'Mathematical equations', NO_ISO_639_1, 'Zmth'],
  ['est', 'Estonian', 'et', LATIN],
  ['eus', 'Basque', 'eu', LATIN],
  ['fao', 'Faroese', 'fo', LATIN],
  ['fas', 'Persian', 'fa', ARABIC, 'rtl'],
  ['fil', 'Filipino', NO_ISO_639_1, LATIN],
  ['fin', 'Finnish', 'fi', LATIN],
  ['fra', 'French', 'fr', LATIN],
  ['frk', 'German (Fraktur)', NO_ISO_639_1, LATIN, 'ltr', ['de-latf']],
  ['frm', 'Middle French', NO_ISO_639_1, LATIN],
  ['fry', 'Western Frisian', 'fy', LATIN],
  ['gla', 'Scottish Gaelic', 'gd', LATIN],
  ['gle', 'Irish', 'ga', LATIN],
  ['glg', 'Galician', 'gl', LATIN],
  ['grc', 'Ancient Greek', NO_ISO_639_1, 'Grek'],
  ['guj', 'Gujarati', 'gu', 'Gujr'],
  ['hat', 'Haitian Creole', 'ht', LATIN],
  ['heb', 'Hebrew', 'he', HEBREW, 'rtl', ['iw']],
  ['hin', 'Hindi', 'hi', DEVANAGARI],
  ['hrv', 'Croatian', 'hr', LATIN],
  ['hun', 'Hungarian', 'hu', LATIN],
  ['hye', 'Armenian', 'hy', 'Armn'],
  ['iku', 'Inuktitut', 'iu', 'Cans'],
  ['ind', 'Indonesian', 'id', LATIN, 'ltr', ['in']],
  ['isl', 'Icelandic', 'is', LATIN],
  ['ita', 'Italian', 'it', LATIN],
  ['ita_old', 'Old Italian', NO_ISO_639_1, LATIN],
  ['jav', 'Javanese', 'jv', LATIN],
  ['jpn', 'Japanese', 'ja', 'Jpan'],
  ['jpn_vert', 'Japanese (vertical)', NO_ISO_639_1, 'Jpan', 'ttb', ['ja-vert']],
  ['kan', 'Kannada', 'kn', 'Knda'],
  ['kat', 'Georgian', 'ka', 'Geor'],
  ['kat_old', 'Old Georgian', NO_ISO_639_1, 'Geor'],
  ['kaz', 'Kazakh', 'kk', CYRILLIC],
  ['khm', 'Khmer', 'km', 'Khmr'],
  ['kir', 'Kyrgyz', 'ky', CYRILLIC],
  ['kmr', 'Kurdish (Kurmanji)', NO_ISO_639_1, LATIN, 'ltr', ['ku']],
  ['kor', 'Korean', 'ko', 'Hang'],
  ['kor_vert', 'Korean (vertical)', NO_ISO_639_1, 'Hang', 'ttb', ['ko-vert']],
  ['lao', 'Lao', 'lo', 'Laoo'],
  ['lat', 'Latin', 'la', LATIN],
  ['lav', 'Latvian', 'lv', LATIN],
  ['lit', 'Lithuanian', 'lt', LATIN],
  ['ltz', 'Luxembourgish', 'lb', LATIN],
  ['mal', 'Malayalam', 'ml', 'Mlym'],
  ['mar', 'Marathi', 'mr', DEVANAGARI],
  ['mkd', 'Macedonian', 'mk', CYRILLIC],
  ['mlt', 'Maltese', 'mt', LATIN],
  ['mon', 'Mongolian', 'mn', CYRILLIC],
  ['mri', 'Maori', 'mi', LATIN],
  ['msa', 'Malay', 'ms', LATIN],
  ['mya', 'Burmese', 'my', 'Mymr'],
  ['nep', 'Nepali', 'ne', DEVANAGARI],
  ['nld', 'Dutch', 'nl', LATIN],
  ['nor', 'Norwegian', 'no', LATIN, 'ltr', ['nb', 'nn']],
  ['oci', 'Occitan', 'oc', LATIN],
  ['ori', 'Odia', 'or', 'Orya'],
  ['pan', 'Punjabi', 'pa', 'Guru'],
  ['pol', 'Polish', 'pl', LATIN],
  ['por', 'Portuguese', 'pt', LATIN],
  ['pus', 'Pashto', 'ps', ARABIC, 'rtl'],
  ['que', 'Quechua', 'qu', LATIN],
  ['ron', 'Romanian', 'ro', LATIN],
  ['rus', 'Russian', 'ru', CYRILLIC],
  ['san', 'Sanskrit', 'sa', DEVANAGARI],
  ['sin', 'Sinhala', 'si', 'Sinh'],
  ['slk', 'Slovak', 'sk', LATIN],
  ['slv', 'Slovenian', 'sl', LATIN],
  ['snd', 'Sindhi', 'sd', ARABIC, 'rtl'],
  ['spa', 'Spanish', 'es', LATIN],
  ['spa_old', 'Old Spanish', NO_ISO_639_1, LATIN],
  ['sqi', 'Albanian', 'sq', LATIN],
  ['srp', 'Serbian', 'sr', CYRILLIC, 'ltr', ['sr-cyrl']],
  ['srp_latn', 'Serbian (Latin)', NO_ISO_639_1, LATIN, 'ltr', ['sr-latn']],
  ['sun', 'Sundanese', 'su', LATIN],
  ['swa', 'Swahili', 'sw', LATIN],
  ['swe', 'Swedish', 'sv', LATIN],
  ['syr', 'Syriac', NO_ISO_639_1, 'Syrc', 'rtl'],
  ['tam', 'Tamil', 'ta', 'Taml'],
  ['tat', 'Tatar', 'tt', CYRILLIC],
  ['tel', 'Telugu', 'te', 'Telu'],
  ['tgk', 'Tajik', 'tg', CYRILLIC],
  ['tha', 'Thai', 'th', 'Thai'],
  ['tir', 'Tigrinya', 'ti', 'Ethi'],
  ['ton', 'Tongan', 'to', LATIN],
  ['tur', 'Turkish', 'tr', LATIN],
  ['uig', 'Uyghur', 'ug', ARABIC, 'rtl'],
  ['ukr', 'Ukrainian', 'uk', CYRILLIC],
  ['urd', 'Urdu', 'ur', ARABIC, 'rtl'],
  ['uzb', 'Uzbek', 'uz', LATIN, 'ltr', ['uz-latn']],
  ['uzb_cyrl', 'Uzbek (Cyrillic)', NO_ISO_639_1, CYRILLIC, 'ltr', ['uz-cyrl']],
  ['vie', 'Vietnamese', 'vi', LATIN],
  ['yid', 'Yiddish', 'yi', HEBREW, 'rtl'],
  ['yor', 'Yoruba', 'yo', LATIN],
];

export const OCR_LANGUAGES: readonly OcrLanguage[] = Object.freeze(
  ROWS.map(([traineddata, name, iso639_1, script, direction = 'ltr', aliases = []]) =>
    Object.freeze({
      traineddata,
      name,
      ...(iso639_1 === NO_ISO_639_1 ? {} : { iso639_1 }),
      script,
      direction,
      aliases: Object.freeze([...aliases]),
    })
  )
);

/** The request spelling of a code: lower case, with `-` as `_`, so `zh-Hans` and `zh_hans` are one spelling. */
function normalize(code: string): string {
  return code.trim().toLowerCase().replace(/-/g, '_');
}

const REGION_SUBTAG = /^([a-z]{2,3})_(?:[a-z]{2}|\d{3})$/;

const BY_CODE: ReadonlyMap<string, OcrLanguage> = (() => {
  const map = new Map<string, OcrLanguage>();
  const add = (code: string, language: OcrLanguage): void => {
    const key = normalize(code);
    // Two languages must never answer to one code: the table is wrong, not the request.
    if (map.has(key) && map.get(key) !== language) throw new Error(`OCR language code '${code}' names two languages`);
    map.set(key, language);
  };
  for (const language of OCR_LANGUAGES) {
    add(language.traineddata, language);
    if (language.iso639_1) add(language.iso639_1, language);
    for (const alias of language.aliases) add(alias, language);
  }
  return map;
})();

/** The language a single code (no `+`) names, or undefined when the table has none by that name. */
export function findOcrLanguage(code: string): OcrLanguage | undefined {
  const key = normalize(code);
  const direct = BY_CODE.get(key);
  if (direct) return direct;
  // A region subtag (`en-US`, `pt-BR`) does not change the data; the language alone decides it.
  const region = REGION_SUBTAG.exec(key);
  return region ? BY_CODE.get(region[1]) : undefined;
}

export interface ResolvedOcrLanguages {
  /** Traineddata names in the order requested, without repeats: `['eng', 'kor']`. */
  readonly traineddata: readonly string[];
  /** The names joined for the engine: `eng+kor`. */
  readonly joined: string;
  /** True when the request was empty or `auto`. */
  readonly auto: boolean;
}

function unsupported(request: string): OcrLanguageUnavailableError {
  const names = OCR_LANGUAGES.map((language) => language.traineddata).join(', ');
  return new OcrLanguageUnavailableError(
    `Unsupported or unrecognized OCR language: '${request.slice(0, MAX_LANGUAGE_REQUEST_CHARS)}'. ` +
      `Supported languages: ${OCR_AUTO_LANGUAGE}, ${names}. ` +
      `Name one language by its traineddata name, ISO 639-1 code or BCP 47 tag, or join up to ${OCR_MAX_LANGUAGES_PER_REQUEST} with '${LANGUAGE_SEPARATOR}'.`
  );
}

/**
 * Resolves a request's language (`auto`, `ko`, `eng+kor`, `zh-Hans`) to traineddata names. An unknown code, an
 * empty part, more than OCR_MAX_LANGUAGES_PER_REQUEST parts, or `auto` combined with another language is a
 * client error (OcrLanguageUnavailableError, HTTP 400). Whether the data is installed is a separate question
 * (503), answered where the data is read.
 */
export function resolveOcrLanguages(request: string | undefined): ResolvedOcrLanguages {
  const text = request === undefined || request.trim() === '' ? OCR_AUTO_LANGUAGE : request;
  if (text.length > MAX_LANGUAGE_REQUEST_CHARS) throw unsupported(text);
  const parts = text.split(LANGUAGE_SEPARATOR);
  if (parts.length > OCR_MAX_LANGUAGES_PER_REQUEST) {
    throw new OcrLanguageUnavailableError(
      `Too many OCR languages in '${text}': at most ${OCR_MAX_LANGUAGES_PER_REQUEST} may be joined with '${LANGUAGE_SEPARATOR}', got ${parts.length}.`
    );
  }
  if (parts.length === 1 && normalize(parts[0]) === OCR_AUTO_LANGUAGE) {
    return { traineddata: [OCR_AUTO_TRAINEDDATA], joined: OCR_AUTO_TRAINEDDATA, auto: true };
  }
  const names: string[] = [];
  for (const part of parts) {
    const language = findOcrLanguage(part);
    if (!language) throw unsupported(text);
    if (!names.includes(language.traineddata)) names.push(language.traineddata);
  }
  return { traineddata: names, joined: names.join(LANGUAGE_SEPARATOR), auto: false };
}

/** The short code a language is listed under: its ISO 639-1 code, or the traineddata name when it has none. */
export function ocrLanguageCode(language: OcrLanguage): string {
  return language.iso639_1 ?? language.traineddata;
}
