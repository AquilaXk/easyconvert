import { describe, expect, it } from 'vitest';
import { assertReadableDwg, identifyDwgVersion } from '../src/lib/conversions/cad-dwg';
import { CadGeometryError, UnprocessableCadInputError, UnsupportedDwgVersionError } from '../src/lib/types';

/**
 * The version code at the start of a DWG file, checked against the table of the Open Design Specification for .dwg files
 * (the "version identifier" table of the file header chapter) written out here, row by row. The table is the oracle: the
 * code under test is never imported to build the expected values.
 */

/** Release names and codes as that table prints them. */
const PUBLISHED_VERSION_TABLE: ReadonlyArray<readonly [code: string, release: string]> = [
  ['MC0.0', 'R1.0'],
  ['AC1.2', 'R1.2'],
  ['AC1.40', 'R1.40'],
  ['AC1.50', 'R2.0'],
  ['AC2.10', 'R2.10'],
  ['AC1002', 'R2.5'],
  ['AC1003', 'R2.6'],
  ['AC1004', 'R9'],
  ['AC1006', 'R10'],
  ['AC1009', 'R11/R12'],
  ['AC1012', 'R13'],
  ['AC1014', 'R14'],
  ['AC1015', 'R2000'],
  ['AC1018', 'R2004'],
  ['AC1021', 'R2007'],
  ['AC1024', 'R2010'],
  ['AC1027', 'R2013'],
  ['AC1032', 'R2018'],
];

/** The object-map layout that the reader decodes reliably starts with R13; its own help text calls the output for older ones experimental. */
const FIRST_READABLE_CODE = 'AC1012';
const READABLE_CODES = PUBLISHED_VERSION_TABLE.slice(PUBLISHED_VERSION_TABLE.findIndex(([code]) => code === FIRST_READABLE_CODE)).map(([code]) => code);

/** A header as every release writes it: the six-character code, five zero bytes, then the rest of the file. */
const header = (code: string): Buffer => Buffer.concat([Buffer.from(code, 'latin1'), Buffer.alloc(64)]);

describe('identifyDwgVersion', () => {
  it.each(PUBLISHED_VERSION_TABLE)('reads %s as release %s', (code, release) => {
    const version = identifyDwgVersion(header(code));
    expect(version).not.toBeNull();
    expect(version?.magic).toBe(code);
    expect(version?.release).toBe(release);
  });

  it('marks exactly the releases from R13 on as readable', () => {
    const readable = PUBLISHED_VERSION_TABLE.filter(([code]) => identifyDwgVersion(header(code))?.readable).map(([code]) => code);
    expect(readable).toEqual(READABLE_CODES);
    expect(readable).toEqual(['AC1012', 'AC1014', 'AC1015', 'AC1018', 'AC1021', 'AC1024', 'AC1027', 'AC1032']);
  });

  it('knows a code of a release newer than the table, and one nobody released, as a DWG that is not readable', () => {
    for (const code of ['AC1033', 'AC1035', 'AC1099', 'AC1013', 'AC1020']) {
      const version = identifyDwgVersion(header(code));
      expect(version?.magic, code).toBe(code);
      expect(version?.readable, code).toBe(false);
    }
  });

  it.each([
    ['an empty file', Buffer.alloc(0)],
    ['a file shorter than the code', Buffer.from('AC10')],
    ['a DXF', Buffer.from('  0\nSECTION\n  2\nHEADER\n')],
    ['a PDF', Buffer.from('%PDF-1.7\n')],
    ['a code in lower case', Buffer.from('ac1015\0\0\0\0\0\0')],
    ['AC and four letters', Buffer.from('ACABCD\0\0\0\0\0\0')],
    ['a code that starts later in the file', Buffer.concat([Buffer.from('\0\0AC1015'), Buffer.alloc(32)])],
  ])('does not take %s for a DWG', (_name, bytes) => {
    expect(identifyDwgVersion(bytes)).toBeNull();
  });
});

describe('assertReadableDwg', () => {
  it.each(READABLE_CODES)('accepts %s and returns its version', (code) => {
    expect(assertReadableDwg(header(code)).magic).toBe(code);
  });

  it.each(PUBLISHED_VERSION_TABLE.filter(([code]) => !READABLE_CODES.includes(code)))('refuses %s (%s) with a typed 422 that names the release and what to do', (code, release) => {
    let refusal: unknown;
    try {
      assertReadableDwg(header(code));
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnsupportedDwgVersionError);
    expect(refusal).toBeInstanceOf(UnprocessableCadInputError);
    expect((refusal as UnsupportedDwgVersionError).status).toBe(422);
    expect((refusal as UnsupportedDwgVersionError).magic).toBe(code);
    const message = (refusal as Error).message;
    expect(message).toContain(release);
    expect(message).toMatch(/R13|AutoCAD 2000|save/i);
  });

  it('refuses a release newer than the table, saying that the reader does not know it yet', () => {
    expect(() => assertReadableDwg(header('AC1040'))).toThrow(UnsupportedDwgVersionError);
    expect(() => assertReadableDwg(header('AC1040'))).toThrow(/This DWG is a release newer than R2018 \(AC1040\)/);
  });

  it('refuses a code between released codes as an unreleased format code, not as a newer release', () => {
    expect(() => assertReadableDwg(header('AC1013'))).toThrow(UnsupportedDwgVersionError);
    expect(() => assertReadableDwg(header('AC1013'))).toThrow(/This DWG is an unreleased format code \(AC1013\)/);
  });

  it('refuses a file that is no DWG with a 400, not a 422: the bytes are not a drawing of any version', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('AC10'), Buffer.from('  0\nSECTION\n'), Buffer.from('MZ\x90\0')]) {
      let refusal: unknown;
      try {
        assertReadableDwg(bytes);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(CadGeometryError);
      expect((refusal as CadGeometryError).status).toBe(400);
      expect((refusal as Error).message).toMatch(/not a DWG/i);
    }
  });
});
