import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { convertFile } from '../src/lib/conversions';
import { convertHwpDocument, parseHwpDocument } from '../src/lib/conversions/hwp';
import { ConversionFailedError, CorruptStreamError, EncryptedOfficeDocumentError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * Real HWP 5.0 documents (provenance: tests/fixtures/hwp/PROVENANCE.md) read against goldens produced by a separate
 * reader written from the format specification (tests/fixtures/hwp/reference-extract.py). The goldens hold the
 * paragraphs and the table grids that reader finds; the converter must find the same text and the same cells.
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'hwp');

interface ReferenceTable {
  rows: number;
  cols: number;
  cells: string[][];
}

interface Reference {
  version: string;
  compressed: boolean;
  encrypted: boolean;
  distributed: boolean;
  sections: number;
  paragraphs: { level: number; text: string }[];
  tables: ReferenceTable[];
}

function readFixture(name: string): Buffer {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.hwp`));
}

function readReference(name: string): Reference {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.reference.json`), 'utf-8')) as Reference;
}

/** The whitespace-separated words of `texts`, sorted: the comparison form that ignores how text is grouped into paragraphs and cells. */
function sortedWords(texts: string[]): string[] {
  return texts.flatMap((text) => text.split(/\s+/).filter(Boolean)).sort((a, b) => a.localeCompare(b));
}

function failureOf(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

const READABLE_DOCUMENTS = ['blank', 'changing-paragraph-text', 'merging-cell', 'noori', 'basics-report'];

describe('fixture provenance', () => {
  it('every fixture is an unmodified copy of the file recorded in PROVENANCE.md', () => {
    const provenance = fs.readFileSync(path.join(FIXTURE_DIR, 'PROVENANCE.md'), 'utf-8');
    const recorded = new Map([...provenance.matchAll(/^\| `([^`]+\.hwp)` \|.*\| ([0-9a-f]{64}) \|$/gm)].map((match) => [match[1], match[2]]));
    const present = fs.readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.hwp')).sort();
    expect([...recorded.keys()].sort()).toEqual(present);
    for (const name of present) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(FIXTURE_DIR, name))).digest('hex'), name).toBe(recorded.get(name));
    }
  });
});

describe('real HWP documents', () => {
  it.each(READABLE_DOCUMENTS)('%s: header fields, text and table grids match the reference reader', (name) => {
    const reference = readReference(name);
    const doc = parseHwpDocument(readFixture(name));

    expect(doc.version).toBe(reference.version);
    expect(doc.isCompressed).toBe(reference.compressed);
    expect(doc.isEncrypted).toBe(reference.encrypted);
    expect(doc.isDistributed).toBe(reference.distributed);

    expect(doc.tables.map((table) => ({ rows: table.rowCount, cols: table.colCount, cells: table.rows }))).toEqual(reference.tables);

    const found = sortedWords([...doc.paragraphs.map((p) => p.text), ...doc.tables.flatMap((table) => table.rows.flat())]);
    const expected = sortedWords([...reference.paragraphs.map((p) => p.text), ...reference.tables.flatMap((table) => table.cells.flat())]);
    expect(found).toEqual(expected);
  });

  it('merging-cell: every cell of the 7 x 7 grid holds its own address', () => {
    const doc = parseHwpDocument(readFixture('merging-cell'));
    expect(doc.tables).toHaveLength(1);
    const [table] = doc.tables;
    expect([table.rowCount, table.colCount]).toEqual([7, 7]);
    expect(table.rows).toEqual(Array.from({ length: 7 }, (_, row) => Array.from({ length: 7 }, (_, col) => `${row},${col}`)));
  });

  it('blank: a document without text has no paragraphs, not a placeholder', () => {
    const doc = parseHwpDocument(readFixture('blank'));
    expect(doc.paragraphs).toEqual([]);
    expect(doc.tables).toEqual([]);
  });

  it('noori: text is the news release, not control-character data decoded as characters', () => {
    const doc = parseHwpDocument(readFixture('noori'));
    expect(doc.paragraphs[0].text).toBe(readReference('noori').paragraphs[0].text);
    expect(doc.paragraphs[0].text.startsWith('□ 과학기술정보통신부(장관 유영민')).toBe(true);
  });

  it('distribution documents keep their content in an encrypted ViewText stream and are refused', () => {
    const failure = failureOf(() => parseHwpDocument(readFixture('distribution')));
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe(
      'Distribution-protected HWP documents keep their text in encrypted ViewText streams and cannot be converted.'
    );
  });
});

describe('inputs that are not readable HWP documents', () => {
  it('plain text under an .hwp name is refused, not turned into a document', async () => {
    const failure = await convertFile(Buffer.from('일반 텍스트 형식의 한글 문서 내용입니다.'), 'hwp', 'pdf', {}, 'plain.hwp').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: the file is not an OLE2 compound file.');
  });

  it('a compound file whose FileHeader lacks the HWP signature is refused', () => {
    const bytes = Buffer.from(readFixture('blank'));
    const at = bytes.indexOf(Buffer.from('HWP Document File'));
    expect(at).toBeGreaterThan(0);
    bytes[at] = 0x58;
    const failure = failureOf(() => parseHwpDocument(bytes));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: the FileHeader stream does not start with the HWP signature.');
  });

  it('a document without BodyText sections is refused', () => {
    const bytes = Buffer.from(readFixture('blank'));
    const name = Buffer.from('Section0', 'utf16le');
    const renamed = Buffer.from('Sectiox0', 'utf16le');
    let renames = 0;
    for (let at = bytes.indexOf(name); at >= 0; at = bytes.indexOf(name, at + name.length)) {
      renamed.copy(bytes, at);
      renames += 1;
    }
    expect(renames).toBeGreaterThan(0);
    const failure = failureOf(() => parseHwpDocument(bytes));
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toBe('Invalid HWP document: it has no BodyText/Section streams.');
  });

  it('a password-protected document is refused with the encrypted-document error', () => {
    const bytes = Buffer.from(readFixture('blank'));
    const at = bytes.indexOf(Buffer.from('HWP Document File'));
    const flagsOffset = at + 36;
    bytes.writeUInt32LE(bytes.readUInt32LE(flagsOffset) | 0x02, flagsOffset);
    const failure = failureOf(() => parseHwpDocument(bytes));
    expect(failure).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect((failure as Error).message).toBe('Encrypted HWP documents with password protection cannot be converted without credentials.');
  });

  it('a target the converter does not write is refused, not answered with a PDF', async () => {
    const doc = parseHwpDocument(readFixture('changing-paragraph-text'));
    const failure = await convertHwpDocument(doc, 'xyz', {}, 'sample').catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe("Cannot convert HWP documents to '.xyz'.");
  });
});

describe('real HWP documents through the converter', () => {
  it('txt: the news release text and its table cells', async () => {
    const reference = readReference('noori');
    const converted = await convertFile(readFixture('noori'), 'hwp', 'txt', {}, 'noori.hwp');
    const text = converted.buffer.toString('utf-8');
    for (const paragraph of reference.paragraphs) expect(text).toContain(paragraph.text);
    for (const cell of reference.tables[0].cells.flat().filter(Boolean)) expect(text).toContain(cell);
  });

  oracleTest('pdf: the reference PDF text extractor finds the words of the document', ['pdftotext', 'pdfinfo'], async () => {
    const reference = readReference('changing-paragraph-text');
    const converted = await convertFile(readFixture('changing-paragraph-text'), 'hwp', 'pdf', {}, 'sample.hwp');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-pdf-'));
    try {
      const pdfPath = path.join(dir, 'sample.pdf');
      fs.writeFileSync(pdfPath, converted.buffer);
      const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', pdfPath, '-'], { encoding: 'utf-8' }).normalize('NFC');
      expect(sortedWords([text])).toEqual(sortedWords(reference.paragraphs.map((p) => p.text.normalize('NFC'))));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('pdf: a blank document is a PDF with no text, not a placeholder title', ['pdftotext', 'pdfinfo'], async () => {
    const converted = await convertFile(readFixture('blank'), 'hwp', 'pdf', {}, 'blank.hwp');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwp-pdf-'));
    try {
      const pdfPath = path.join(dir, 'blank.pdf');
      fs.writeFileSync(pdfPath, converted.buffer);
      expect(execFileSync(requireOracleTool('pdftotext'), [pdfPath, '-'], { encoding: 'utf-8' }).trim()).toBe('');
      expect(execFileSync(requireOracleTool('pdfinfo'), [pdfPath], { encoding: 'utf-8' })).toMatch(/^Pages:\s+1$/m);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
