import { describe, expect, it } from 'vitest';
import { resolvePdfAConformance, directPdfAExportConformance } from '../src/lib/conversions/pdf-export-options';
import { resolveLibreOfficeFilter } from '../src/worker/libreoffice-pool';
import { UnsupportedOptionError, type ConversionOptions } from '../src/lib/types';

/**
 * Which PDF/A level a request asks for. `pdfVersion` and `pdfStandard` are two independent ways
 * to say it; neither may hide the other, and a PDF/A-looking value that is not a supported level
 * is a client error, never a silently ignored option.
 */

/** The default export FilterData (keep JPEG streams, write the outline) with PDF/A-2 selected, written by hand. */
const KEEP_JPEG_DATA_WITH_PDFA_2 =
  '{"ReduceImageResolution":{"type":"boolean","value":"false"},"Quality":{"type":"long","value":"100"},' +
  '"ExportBookmarks":{"type":"boolean","value":"true"},"SelectPdfVersion":{"type":"long","value":"2"}}';

describe('resolvePdfAConformance reads pdfVersion and pdfStandard independently', () => {
  it('reads pdfStandard when pdfVersion holds a plain PDF version', () => {
    expect(resolvePdfAConformance({ pdfVersion: '1.7', pdfStandard: 'pdfa-2b' })).toBe('pdfa-2b');
  });

  it('reads pdfVersion when pdfStandard is absent', () => {
    expect(resolvePdfAConformance({ pdfVersion: 'PDF/A-3B' })).toBe('pdfa-3b');
  });

  it('rejects two different PDF/A levels', () => {
    expect(() => resolvePdfAConformance({ pdfVersion: 'pdfa-1b', pdfStandard: 'pdfa-2b' })).toThrow(
      'Conflicting PDF/A levels requested: pdfa-1b, pdfa-2b. Request one level.'
    );
  });

  it('asks for no PDF/A when neither field names a PDF/A level', () => {
    expect(resolvePdfAConformance({ pdfVersion: '1.7' })).toBeNull();
    expect(resolvePdfAConformance({})).toBeNull();
  });

  it.each(['pdfa-2u', 'pdf/a-1a', 'pdfa-4', 'PDFA3B'])('rejects the unsupported PDF/A level %s in pdfStandard', (level) => {
    const options = { pdfStandard: level } as unknown as ConversionOptions;
    expect(() => resolvePdfAConformance(options)).toThrow(UnsupportedOptionError);
    expect(() => resolvePdfAConformance(options)).toThrow(`Unsupported PDF/A level in pdfStandard: ${level}`);
  });

  it('rejects an unsupported PDF/A level in pdfVersion', () => {
    expect(() => resolvePdfAConformance({ pdfVersion: 'pdfa-2u' })).toThrow('Unsupported PDF/A level in pdfVersion: pdfa-2u');
  });

  it('rejects a pdfVersion that is not a string instead of failing with a TypeError', () => {
    const options = { pdfVersion: 1.7 } as unknown as ConversionOptions;
    expect(() => resolvePdfAConformance(options)).toThrow(UnsupportedOptionError);
    expect(() => resolvePdfAConformance(options)).toThrow('The pdfVersion option must be a string.');
  });
});

describe('the default PDF/A level', () => {
  it.each([
    ['an empty pdfa object', { pdfa: {} }],
    ['pdfa set to true', { pdfa: true }],
    ['the bare pdfa name in pdfStandard', { pdfStandard: 'pdfa' }],
    ['the bare pdfa name in pdfVersion', { pdfVersion: 'pdfa' }],
  ])('is PDF/A-2b for %s', (_label, options) => {
    expect(resolvePdfAConformance(options as unknown as ConversionOptions)).toBe('pdfa-2b');
  });

  it('keeps an explicit PDF/A-1b request at 1b', () => {
    expect(resolvePdfAConformance({ pdfa: { conformance: 'pdfa-1b' } })).toBe('pdfa-1b');
    expect(resolvePdfAConformance({ pdfStandard: 'pdfa-1b' })).toBe('pdfa-1b');
  });

  it('selects PDF/A-2 in the export for the bare pdfa name', () => {
    expect(resolveLibreOfficeFilter('pdf', 'docx', { pdfStandard: 'pdfa' })).toBe(
      `pdf:writer_pdf_Export:${KEEP_JPEG_DATA_WITH_PDFA_2}`
    );
  });
});

describe('the export filter follows the resolved level', () => {
  it('selects PDF/A-2 in the export when pdfStandard says so next to a plain pdfVersion', () => {
    const filter = resolveLibreOfficeFilter('pdf', 'docx', { pdfVersion: '1.7', pdfStandard: 'pdfa-2b' });
    expect(filter).toBe(`pdf:writer_pdf_Export:${KEEP_JPEG_DATA_WITH_PDFA_2}`);
    expect(directPdfAExportConformance({ pdfVersion: '1.7', pdfStandard: 'pdfa-2b' })).toBe('pdfa-2b');
  });
});
