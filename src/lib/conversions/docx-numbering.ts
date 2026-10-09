import { DocumentFormatError, MAX_LIST_LEVELS } from './document-model';
import { childElements, firstChild, type XmlElement } from './xml-tree';

/**
 * Word list numbering (ECMA-376 Part 1, 17.9): abstract numbering definitions (`w:abstractNum`), numbering instances
 * (`w:num`) with their level overrides, and the counters that turn a paragraph's `w:numPr` into the marker Word
 * shows ("1.", "a)", "1.2.3", a bullet). Counters follow 17.9.6 (`w:lvlRestart`), 17.9.8 (`w:lvlText`) and 17.9.26
 * (`w:startOverride`).
 */

/** Most numbering definitions and instances one document may declare. */
export const MAX_NUMBERING_DEFINITIONS = 20_000;
/** Longest chain of linked numbering styles followed (17.9.21 `w:numStyleLink`). */
const MAX_NUMBERING_LINK_DEPTH = 8;
const DEFAULT_LIST_START = 1;
const LATIN_ALPHABET_SIZE = 26;
const FIRST_LOWER_LETTER = 0x61;
const FIRST_UPPER_LETTER = 0x41;
const ROMAN_NUMERALS: readonly (readonly [number, string])[] = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];
/** Largest value written as a roman numeral; Word writes larger ones as decimal. */
const MAX_ROMAN_VALUE = 3999;
const KOREAN_GANADA = '가나다라마바사아자차카타파하';
const KOREAN_CHOSUNG = 'ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ';
const CIRCLED_DIGIT_FIRST = 0x2460;
const CIRCLED_DIGIT_COUNT = 20;
const ZERO_PAD_WIDTH = 2;
const ORDINAL_TEEN_LIMIT = 20;
const ORDINAL_TEEN_START = 10;
const ORDINAL_SUFFIXES: readonly string[] = ['th', 'st', 'nd', 'rd'];
const ORDINAL_TENS = 10;
const ORDINAL_HUNDREDS = 100;

export interface NumberingLevel {
  readonly start: number;
  readonly format: string;
  readonly text: string;
  /** `w:lvlRestart`: undefined restarts after any higher level, 0 never restarts. */
  readonly restart?: number;
  readonly legal: boolean;
}

interface AbstractNumbering {
  readonly levels: (NumberingLevel | undefined)[];
  readonly numStyleLink?: string;
}

interface NumberingInstance {
  readonly abstractId: number;
  readonly startOverrides: ReadonlyMap<number, number>;
  readonly levelOverrides: ReadonlyMap<number, NumberingLevel>;
}

export interface ListMarker {
  readonly ordered: boolean;
  readonly marker: string;
  readonly number: number;
  readonly format: string;
}

/** Bullet glyphs Word stores as private-use code points of symbol fonts, mapped to Unicode. */
const BULLET_GLYPHS: ReadonlyMap<string, string> = new Map([
  ['', '•'],
  ['', '▪'],
  ['', '➢'],
  ['', '✓'],
  ['', '❖'],
  ['', '◻'],
  ['o', '◦'],
]);
const DEFAULT_BULLET = '•';

function intAttribute(element: XmlElement, name: string): number | undefined {
  const raw = element.attrs.get(name);
  if (raw === undefined) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : undefined;
}

function readLevel(element: XmlElement): NumberingLevel {
  const format = firstChild(element, 'numFmt')?.attrs.get('val') ?? 'decimal';
  const legal = firstChild(element, 'isLgl') !== undefined;
  const restartElement = firstChild(element, 'lvlRestart');
  return {
    start: (() => {
      const startElement = firstChild(element, 'start');
      return startElement ? (intAttribute(startElement, 'val') ?? DEFAULT_LIST_START) : DEFAULT_LIST_START;
    })(),
    format,
    text: firstChild(element, 'lvlText')?.attrs.get('val') ?? '',
    restart: restartElement ? intAttribute(restartElement, 'val') : undefined,
    legal,
  };
}

function letters(value: number, base: number): string {
  // Word repeats the letter: 27 is "aa", 53 is "aaa".
  const letter = String.fromCharCode(base + ((value - 1) % LATIN_ALPHABET_SIZE));
  return letter.repeat(Math.floor((value - 1) / LATIN_ALPHABET_SIZE) + 1);
}

function roman(value: number): string {
  let remaining = value;
  let out = '';
  for (const [size, glyph] of ROMAN_NUMERALS) {
    while (remaining >= size) {
      out += glyph;
      remaining -= size;
    }
  }
  return out;
}

function ordinal(value: number): string {
  const lastTwo = value % ORDINAL_HUNDREDS;
  const inTeens = lastTwo >= ORDINAL_TEEN_START && lastTwo < ORDINAL_TEEN_LIMIT;
  const suffix = inTeens ? ORDINAL_SUFFIXES[0] : (ORDINAL_SUFFIXES[value % ORDINAL_TENS] ?? ORDINAL_SUFFIXES[0]);
  return `${value}${suffix}`;
}

/** `value` written in the numbering format `format` (ECMA-376 17.18.59 ST_NumberFormat). Unknown formats are decimal. */
export function formatListNumber(value: number, format: string): string {
  switch (format) {
    case 'decimalZero':
      return String(value).padStart(ZERO_PAD_WIDTH, '0');
    case 'lowerLetter':
      return letters(value, FIRST_LOWER_LETTER);
    case 'upperLetter':
      return letters(value, FIRST_UPPER_LETTER);
    case 'lowerRoman':
      return value <= MAX_ROMAN_VALUE ? roman(value) : String(value);
    case 'upperRoman':
      return value <= MAX_ROMAN_VALUE ? roman(value).toUpperCase() : String(value);
    case 'ordinal':
      return ordinal(value);
    case 'ganada':
      return KOREAN_GANADA[(value - 1) % KOREAN_GANADA.length];
    case 'chosung':
      return KOREAN_CHOSUNG[(value - 1) % KOREAN_CHOSUNG.length];
    case 'decimalEnclosedCircle':
      return value <= CIRCLED_DIGIT_COUNT ? String.fromCharCode(CIRCLED_DIGIT_FIRST + value - 1) : String(value);
    case 'none':
      return '';
    default:
      return String(value);
  }
}

/** True for formats that number items (everything but a bullet or no marker). */
function isOrderedFormat(format: string): boolean {
  return format !== 'bullet' && format !== 'none';
}

function bulletMarker(text: string): string {
  const glyph = text.trim();
  return BULLET_GLYPHS.get(glyph) ?? (glyph.length > 0 && !/[-]/.test(glyph) ? glyph : DEFAULT_BULLET);
}

export class NumberingDefinitions {
  private readonly abstracts = new Map<number, AbstractNumbering>();
  private readonly instances = new Map<number, NumberingInstance>();
  /** Counters of every level, shared by the instances of one abstract definition unless an instance overrides its levels. */
  private readonly counters = new Map<string, (number | undefined)[]>();
  private readonly appliedOverrides = new Set<string>();
  /** Style id of a numbering style to the numId its paragraph properties name. */
  private readonly styleNumbering: ReadonlyMap<string, number>;

  constructor(root: XmlElement | undefined, styleNumbering: ReadonlyMap<string, number>) {
    this.styleNumbering = styleNumbering;
    if (!root) return;
    let declared = 0;
    for (const child of childElements(root)) {
      declared += 1;
      if (declared > MAX_NUMBERING_DEFINITIONS) {
        throw new DocumentFormatError(`word/numbering.xml declares more than ${MAX_NUMBERING_DEFINITIONS} numbering definitions.`);
      }
      if (child.local === 'abstractNum') this.readAbstract(child);
      else if (child.local === 'num') this.readInstance(child);
    }
  }

  private readAbstract(element: XmlElement): void {
    const id = intAttribute(element, 'abstractNumId');
    if (id === undefined) throw new DocumentFormatError('word/numbering.xml has a w:abstractNum without w:abstractNumId.');
    const levels: (NumberingLevel | undefined)[] = new Array<NumberingLevel | undefined>(MAX_LIST_LEVELS).fill(undefined);
    for (const lvl of childElements(element, 'lvl')) {
      const index = intAttribute(lvl, 'ilvl');
      if (index === undefined || index < 0 || index >= MAX_LIST_LEVELS) {
        throw new DocumentFormatError(`word/numbering.xml has a numbering level outside 0-${MAX_LIST_LEVELS - 1}.`);
      }
      levels[index] = readLevel(lvl);
    }
    this.abstracts.set(id, { levels, numStyleLink: firstChild(element, 'numStyleLink')?.attrs.get('val') });
  }

  private readInstance(element: XmlElement): void {
    const numId = intAttribute(element, 'numId');
    const abstractId = firstChild(element, 'abstractNumId');
    const abstract = abstractId ? intAttribute(abstractId, 'val') : undefined;
    if (numId === undefined || abstract === undefined) {
      throw new DocumentFormatError('word/numbering.xml has a w:num without w:numId or w:abstractNumId.');
    }
    const startOverrides = new Map<number, number>();
    const levelOverrides = new Map<number, NumberingLevel>();
    for (const override of childElements(element, 'lvlOverride')) {
      const index = intAttribute(override, 'ilvl');
      if (index === undefined || index < 0 || index >= MAX_LIST_LEVELS) continue;
      const start = firstChild(override, 'startOverride');
      const startValue = start ? intAttribute(start, 'val') : undefined;
      if (startValue !== undefined) startOverrides.set(index, startValue);
      const lvl = firstChild(override, 'lvl');
      if (lvl) levelOverrides.set(index, readLevel(lvl));
    }
    this.instances.set(numId, { abstractId: abstract, startOverrides, levelOverrides });
  }

  /** True when `numId` names a numbering instance. */
  has(numId: number): boolean {
    return this.instances.has(numId);
  }

  private resolveAbstract(abstractId: number, depth: number): AbstractNumbering | undefined {
    const abstract = this.abstracts.get(abstractId);
    if (!abstract || !abstract.numStyleLink) return abstract;
    if (depth >= MAX_NUMBERING_LINK_DEPTH) {
      throw new DocumentFormatError('word/numbering.xml links numbering styles more than ' + MAX_NUMBERING_LINK_DEPTH + ' levels deep.');
    }
    const linkedNumId = this.styleNumbering.get(abstract.numStyleLink);
    const linked = linkedNumId === undefined ? undefined : this.instances.get(linkedNumId);
    return linked ? this.resolveAbstract(linked.abstractId, depth + 1) : abstract;
  }

  /**
   * The marker of the next item at level `ilvl` of list `numId`, advancing the counters. Undefined when the numbering
   * instance does not exist (Word then shows no list marker).
   */
  next(numId: number, ilvl: number): ListMarker | undefined {
    const instance = this.instances.get(numId);
    if (!instance) return undefined;
    const level = Math.min(Math.max(ilvl, 0), MAX_LIST_LEVELS - 1);
    const abstract = this.resolveAbstract(instance.abstractId, 0);
    if (!abstract) return undefined;

    const sharedKey = instance.startOverrides.size > 0 || instance.levelOverrides.size > 0 ? `n${numId}` : `a${instance.abstractId}`;
    let counters = this.counters.get(sharedKey);
    if (!counters) {
      counters = new Array<number | undefined>(MAX_LIST_LEVELS).fill(undefined);
      this.counters.set(sharedKey, counters);
    }

    const levelOf = (index: number): NumberingLevel => instance.levelOverrides.get(index) ?? abstract.levels[index] ?? DEFAULT_LEVEL;
    const definition = levelOf(level);

    const overrideKey = `${numId}:${level}`;
    const startOverride = instance.startOverrides.get(level);
    if (startOverride !== undefined && !this.appliedOverrides.has(overrideKey)) {
      this.appliedOverrides.add(overrideKey);
      counters[level] = startOverride - 1;
    }
    counters[level] = counters[level] === undefined ? definition.start : (counters[level] as number) + 1;

    for (let deeper = level + 1; deeper < MAX_LIST_LEVELS; deeper += 1) {
      const restart = levelOf(deeper).restart;
      if (restart === 0) continue;
      const threshold = restart === undefined ? deeper - 1 : restart - 1;
      if (level <= threshold) counters[deeper] = undefined;
    }

    const ordered = isOrderedFormat(definition.format);
    const value = counters[level] as number;
    if (!ordered) {
      return { ordered, marker: definition.format === 'none' ? '' : bulletMarker(definition.text), number: value, format: definition.format };
    }
    const template = definition.text === '' ? `%${level + 1}.` : definition.text;
    const marker = template.replace(/%([1-9])/g, (_match, digit: string) => {
      const referenced = Number(digit) - 1;
      const referencedLevel = levelOf(referenced);
      const referencedValue = counters?.[referenced] ?? referencedLevel.start;
      const format = definition.legal ? 'decimal' : referencedLevel.format;
      return formatListNumber(referencedValue, format);
    });
    return { ordered, marker, number: value, format: definition.format };
  }
}

const DEFAULT_LEVEL: NumberingLevel = { start: DEFAULT_LIST_START, format: 'decimal', text: '', legal: false };
