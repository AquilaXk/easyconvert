import { describe, expect, it } from 'vitest';
import {
  CONVERSION_CLASSES,
  CREDITS_PER_CLASS,
  IWORK_FORMATS,
  OFFICE_FORMATS,
  PACKAGE_SIZES,
  SUBSCRIPTION_SIZES,
  baseCredits,
  conversionClassOf,
  minuteSurcharge,
  priceIdVariable,
  startedMinutes,
} from '../src/lib/billing/credits';
import { FORMAT_REGISTRY } from '../src/lib/registry';

/** The conversion classes of entry 285: one table, read against the registry. */

const PAIRS = Object.values(FORMAT_REGISTRY).flatMap((source) => source.targetFormats.map((target) => ({ source: source.id, target })));

describe('the cost of each class', () => {
  it('is 1 for a general conversion, 2 for Office or iWork to PDF and 4 for PDF to Office', () => {
    expect(CREDITS_PER_CLASS).toEqual({ general: 1, 'office-to-pdf': 2, 'iwork-to-pdf': 2, 'pdf-to-office': 4 });
    expect([...CONVERSION_CLASSES].sort()).toEqual(Object.keys(CREDITS_PER_CLASS).sort());
  });

  it('classes the named pairs', () => {
    expect(baseCredits('png', 'jpg')).toBe(1);
    expect(baseCredits('mp4', 'mp3')).toBe(1);
    expect(baseCredits('docx', 'pdf')).toBe(2);
    expect(baseCredits('XLSX', 'PDF')).toBe(2);
    expect(baseCredits('pptx', 'pdf')).toBe(2);
    expect(baseCredits('odt', 'pdf')).toBe(2);
    expect(baseCredits('pages', 'pdf')).toBe(2);
    expect(baseCredits('numbers', 'pdf')).toBe(2);
    expect(baseCredits('key', 'pdf')).toBe(2);
    expect(baseCredits('pdf', 'docx')).toBe(4);
    expect(baseCredits('pdf', 'xlsx')).toBe(4);
    expect(baseCredits('pdf', 'pptx')).toBe(4);
    expect(baseCredits('pdf', 'doc')).toBe(4);
  });

  it('does not class a conversion between two office formats, or to a format that is not office, as PDF to Office', () => {
    expect(conversionClassOf('docx', 'odt')).toBe('general');
    expect(conversionClassOf('docx', 'txt')).toBe('general');
    expect(conversionClassOf('pdf', 'png')).toBe('general');
    expect(conversionClassOf('pdf', 'txt')).toBe('general');
    expect(conversionClassOf('pages', 'docx')).toBe('general');
    expect(conversionClassOf('txt', 'pdf')).toBe('general');
  });
});

describe('the class table against the registry', () => {
  it('names only formats the registry has, in the document, spreadsheet and presentation categories', () => {
    for (const id of [...OFFICE_FORMATS, ...IWORK_FORMATS]) {
      const format = FORMAT_REGISTRY[id];
      expect(format, id).toBeDefined();
      expect(['document', 'spreadsheet', 'presentation'], id).toContain(format.category);
    }
  });

  it('keeps iWork to the three formats of Apple and out of the office set', () => {
    expect([...IWORK_FORMATS].sort()).toEqual(['key', 'numbers', 'pages']);
    for (const id of IWORK_FORMATS) expect(OFFICE_FORMATS.has(id)).toBe(false);
  });

  it('classes every registry pair by its source and target, and every class has pairs', () => {
    const counts = new Map<string, number>();
    for (const { source, target } of PAIRS) {
      const expected =
        target === 'pdf' && OFFICE_FORMATS.has(source) ? 'office-to-pdf' : target === 'pdf' && IWORK_FORMATS.has(source) ? 'iwork-to-pdf' : source === 'pdf' && OFFICE_FORMATS.has(target) ? 'pdf-to-office' : 'general';
      expect(conversionClassOf(source, target), `${source} to ${target}`).toBe(expected);
      counts.set(expected, (counts.get(expected) ?? 0) + 1);
    }
    for (const kind of CONVERSION_CLASSES) expect(counts.get(kind) ?? 0, kind).toBeGreaterThan(0);
  });

  it('lists every office source the registry converts to PDF and every office target it converts a PDF to', () => {
    const toPdf = PAIRS.filter(({ target }) => target === 'pdf').map(({ source }) => source);
    for (const source of toPdf) {
      const cost = baseCredits(source, 'pdf');
      expect(cost, source).toBe(OFFICE_FORMATS.has(source) || IWORK_FORMATS.has(source) ? 2 : 1);
    }
    expect(toPdf).toEqual(expect.arrayContaining(['docx', 'xlsx', 'pptx', 'pages', 'numbers', 'key']));
    const fromPdf = PAIRS.filter(({ source }) => source === 'pdf').map(({ target }) => target);
    expect(fromPdf.filter((target) => OFFICE_FORMATS.has(target)).sort()).toEqual(['doc', 'docx', 'ppt', 'pptx', 'rtf', 'xls', 'xlsx']);
  });
});

describe('the minute surcharge', () => {
  it('counts a started minute as a minute and charges from the second one', () => {
    expect([0, 1, 59_999, 60_000, 60_001, 119_999, 120_000, 120_001, 600_000].map(startedMinutes)).toEqual([0, 1, 1, 1, 2, 2, 2, 3, 10]);
    expect([0, 1, 59_999, 60_000, 60_001, 119_999, 120_000, 120_001, 600_000].map(minuteSurcharge)).toEqual([0, 0, 0, 0, 1, 1, 1, 2, 9]);
  });

  it('charges nothing for a time that is not a positive number', () => {
    expect([-5, Number.NaN, Number.POSITIVE_INFINITY].map(minuteSurcharge)).toEqual([0, 0, 0]);
  });
});

describe('the sizes that are sold', () => {
  it('are the packages and subscriptions QA set, each with its own price variable', () => {
    expect(PACKAGE_SIZES).toEqual([500, 1000, 2500, 5000, 10000]);
    expect(SUBSCRIPTION_SIZES).toEqual([1000, 2500, 5000, 10000]);
    expect(priceIdVariable('package', 500)).toBe('PADDLE_PRICE_ID_PACKAGE_500');
    expect(priceIdVariable('subscription', 10000)).toBe('PADDLE_PRICE_ID_SUBSCRIPTION_10000');
  });
});
