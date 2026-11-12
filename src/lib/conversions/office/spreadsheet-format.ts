import { DAY_ZERO_1900, MS_PER_DAY } from '../xlsx-writer';

/**
 * XLSX Source Parser & Converter
 */
/** Built-in number formats (ECMA-376 Part 1, 18.8.30) that show numbers, with the fraction digits each one shows. */
const BUILTIN_FRACTION_DIGITS: ReadonlyMap<number, number> = new Map([
  [1, 0], // 0
  [2, 2], // 0.00
  [3, 0], // #,##0
  [4, 2], // #,##0.00
  [9, 0], // 0%
  [10, 2], // 0.00%
  [37, 0], // #,##0 ;(#,##0)
  [38, 0], // #,##0 ;[Red](#,##0)
  [39, 2], // #,##0.00;(#,##0.00)
  [40, 2], // #,##0.00;[Red](#,##0.00)
  [44, 2], // accounting, two decimals
]);

const BUILTIN_PERCENT_IDS: ReadonlySet<number> = new Set([9, 10]);

const BUILTIN_GROUPED_IDS: ReadonlySet<number> = new Set([3, 4, 37, 38, 39, 40, 44]);

const BUILTIN_CURRENCY_IDS: ReadonlySet<number> = new Set([44]);

const CURRENCY_SYMBOLS = ['$', '\u20a9', '\u20ac', '\u00a3'];

const DEFAULT_CURRENCY_SYMBOL = '$';

/** A format code made only of digit placeholders and one decimal point shows a plain fixed-point number. */
const PLAIN_NUMBER_FORMAT = /^[0#?]+(\.[0#?]+)?$/;

/** A comma between two digit placeholders groups thousands; a trailing comma scales by a thousand instead. */
const THOUSANDS_SEPARATOR = /[0#?],[0#?]/;

/**
 * The first section of a format code with `[$-409]` (a locale) dropped and `[$EUR-407]` reduced to its currency symbol,
 * other bracketed parts (colours, conditions) removed. Quoted text is kept: `"$"#,##0` names its currency in quotes.
 */
function numberFormatFirstSection(formatCode: string): string {
  return formatCode
    .replace(/\[\$([^\]-]*)[^\]]*\]/g, '$1')
    .replace(/\[[^\]]*\]/g, '')
    .split(';')[0];
}

/** What is left of a format section once quoted text, escaped characters, padding and alignment directives are removed: placeholders and separators. */
function numberFormatSkeleton(firstSection: string): string {
  return firstSection.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '');
}

/** Fewest and most fraction digits a format code shows: `0` placeholders after the decimal point are required, `#` and `?` optional. */
function numberFormatFractionDigits(skeleton: string): { min: number; max: number } {
  const fraction = /\.([0#?]*)/.exec(skeleton)?.[1] ?? '';
  return { min: (fraction.match(/0/g) ?? []).length, max: fraction.length };
}

/**
 * The day a date serial counts from. The 1900 system (the default) has day zero on 1899-12-30, which makes serials from 61 on agree
 * with Excel's (Lotus 1-2-3 leap day bug at day 60); the 1904 system (`workbookPr date1904`, ECMA-376 Part 1, 18.2.28) has day zero on
 * 1904-01-01.
 */
export interface SpreadsheetDateSystem {
  readonly dayZero: number;
}

export const DATE_SYSTEM_1900: SpreadsheetDateSystem = { dayZero: DAY_ZERO_1900 };

export const DATE_SYSTEM_1904: SpreadsheetDateSystem = { dayZero: Date.UTC(1904, 0, 1) };

/**
 * Formats a raw spreadsheet cell value according to its Excel number format: percent, grouped thousands, currency and
 * fixed-point formats show the fraction digits the format code asks for; dates become ISO dates. Anything else is
 * shown as stored.
 */
export function formatSpreadsheetCellValue(
  rawVal: string,
  numFmtId?: number,
  customFormat?: string,
  dateSystem: SpreadsheetDateSystem = DATE_SYSTEM_1900
): string {
  if (!rawVal || isNaN(Number(rawVal))) return rawVal;
  const num = Number(rawVal);

  const firstSection = customFormat === undefined ? undefined : numberFormatFirstSection(customFormat);
  const skeleton = firstSection === undefined ? undefined : numberFormatSkeleton(firstSection);
  const builtinDigits = numFmtId === undefined ? undefined : BUILTIN_FRACTION_DIGITS.get(numFmtId);
  const digits =
    skeleton === undefined
      ? { min: builtinDigits ?? 0, max: builtinDigits ?? 0 }
      : numberFormatFractionDigits(skeleton);
  const grouped =
    (skeleton !== undefined && THOUSANDS_SEPARATOR.test(skeleton)) || (numFmtId !== undefined && BUILTIN_GROUPED_IDS.has(numFmtId));
  const show = (value: number, extra: Intl.NumberFormatOptions = {}): string =>
    new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits.min,
      maximumFractionDigits: digits.max,
      useGrouping: grouped,
      ...extra,
    }).format(value);

  // Currency formats (numFmtId 44, or custom formats naming a currency symbol)
  const symbol = firstSection === undefined ? undefined : CURRENCY_SYMBOLS.find((candidate) => firstSection.includes(candidate));
  if (symbol !== undefined || (numFmtId !== undefined && BUILTIN_CURRENCY_IDS.has(numFmtId))) {
    return `${num < 0 ? '-' : ''}${symbol ?? DEFAULT_CURRENCY_SYMBOL}${show(Math.abs(num))}`;
  }

  // Percentage formats (numFmtId 9, 10 or a code containing '%'): Intl scales on the decimal digits, not on the binary double
  if ((numFmtId !== undefined && BUILTIN_PERCENT_IDS.has(numFmtId)) || (skeleton !== undefined && skeleton.includes('%'))) {
    return show(num, { style: 'percent' });
  }

  // Grouped thousands (numFmtId 3, 4, 37 to 40 or a code with a thousands separator) and plain fixed-point formats
  if (grouped || (skeleton !== undefined ? PLAIN_NUMBER_FORMAT.test(skeleton) : builtinDigits !== undefined)) {
    return show(num);
  }

  // Excel serial date formatting (numFmtId 14..22 or contains date tokens)
  if (
    (numFmtId !== undefined && numFmtId >= 14 && numFmtId <= 22) ||
    (customFormat &&
      (customFormat.toLowerCase().includes('yy') ||
        customFormat.toLowerCase().includes('mm') ||
        customFormat.toLowerCase().includes('dd')))
  ) {
    const date = new Date(dateSystem.dayZero + num * MS_PER_DAY);
    if (!isNaN(date.getTime())) {
      return date.toISOString().split('T')[0];
    }
  }

  return rawVal;
}
