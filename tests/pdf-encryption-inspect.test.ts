import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { MAX_CROSS_REFERENCE_SECTIONS, PDF_TRAILER_SCAN_BYTES, inspectPdfEncryption } from '../src/lib/conversions/pdf-encryption';
import {
  ENCRYPTION_VARIANTS,
  plainPdf,
  qpdfEncrypt,
  qpdfEncryptionReport,
  type ObjectStreamMode,
} from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * #571: encryption is detected from the trailer and the cross-reference data with a minimal bounded parser, before
 * any pdf-lib load. Every encrypted fixture is written by the qpdf CLI; the expected V, R and P come from
 * `qpdf --json`, not from the parser under test.
 */

const OWNER = 'owner-secret-1';
const STRUCTURES: readonly ObjectStreamMode[] = ['classic', 'objstm'];

/** A classic-xref PDF built byte by byte, with `trailerEntries` in its last trailer. */
function handBuilt(trailerEntries: string, prefix = ''): Buffer {
  const header = '%PDF-1.4\n';
  const catalog = '1 0 obj\n<< /Type /Catalog >>\nendobj\n';
  const encrypt =
    '2 0 obj\n<< /Filter /Standard /V 1 /R 2 /O (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa) /U (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) /P 4294967252 >>\nendobj\n';
  const body = header + catalog + encrypt;
  const entry = (offset: number): string => `${String(offset).padStart(10, '0')} 00000 n \n`;
  // Offsets count from the %PDF header, as readers resolve them when bytes precede it.
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const xref = `xref\n0 3\n0000000000 65535 f \n${entry(header.length)}${entry(header.length + catalog.length)}`;
  const trailer = `trailer\n<< /Size 3 /Root 1 0 R ${trailerEntries} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(prefix + body + xref + trailer, 'latin1');
}

describe.skipIf(skipWithoutTools('qpdf', 'pdftotext'))('inspectPdfEncryption on qpdf-encrypted files', () => {
  for (const variant of ENCRYPTION_VARIANTS) {
    for (const structure of STRUCTURES) {
      it(`${variant.name} with a ${structure} cross-reference reports the parameters qpdf reports`, async () => {
        const encrypted = qpdfEncrypt(await plainPdf(), { variant, userPassword: 'user-secret-1', ownerPassword: OWNER, modify: 'none', structure });
        const expected = qpdfEncryptionReport(encrypted, OWNER);

        expect(inspectPdfEncryption(encrypted)).toEqual({
          encrypted: true,
          filter: 'Standard',
          v: expected.V,
          r: expected.R,
          p: expected.P,
        });
        expect(expected).toMatchObject({ V: variant.version, R: variant.revision });
      });
    }
  }

  it('reports a linearized encrypted file as encrypted', async () => {
    const encrypted = qpdfEncrypt(await plainPdf(), { variant: ENCRYPTION_VARIANTS[3], userPassword: 'u', linearize: true });
    expect(inspectPdfEncryption(encrypted)).toMatchObject({ encrypted: true, filter: 'Standard', r: 6, v: 5 });
  });

  it('reports encryption that only an older trailer of an incremental update names', async () => {
    const encrypted = qpdfEncrypt(await plainPdf(), { variant: ENCRYPTION_VARIANTS[2], structure: 'classic' });
    const previous = encrypted.toString('latin1').lastIndexOf('\nxref\n') + 1;
    const update = `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 99 /Prev ${previous} >>\nstartxref\n${encrypted.length}\n%%EOF\n`;
    const appended = Buffer.concat([encrypted, Buffer.from(update, 'latin1')]);
    expect(inspectPdfEncryption(appended)).toMatchObject({ encrypted: true });
  });
});

describe.skipIf(skipWithoutTools('pdftotext'))('inspectPdfEncryption on unencrypted files', () => {
  it('reports a pdf-lib file with a cross-reference stream as not encrypted', async () => {
    expect(inspectPdfEncryption(await plainPdf())).toEqual({ encrypted: false });
  });

  it('reports a pdf-lib file with a classic cross-reference table as not encrypted', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    const classic = Buffer.from(await doc.save({ useObjectStreams: false }));
    expect(classic.includes('xref\n')).toBe(true);
    expect(inspectPdfEncryption(classic)).toEqual({ encrypted: false });
  });

  it('does not take the word /Encrypt inside a string or another dictionary for an Encrypt entry', () => {
    const pdf = handBuilt('/Info << /Title (/Encrypt 2 0 R) /Other << /Encrypt 2 0 R >> >>');
    expect(pdf.includes('/Encrypt')).toBe(true);
    expect(inspectPdfEncryption(pdf)).toEqual({ encrypted: false });
  });
});

describe('inspectPdfEncryption on hand-built trailers', () => {
  it('reads a direct Encrypt dictionary and normalises an unsigned P to its signed value', () => {
    const pdf = handBuilt('/Encrypt << /Filter /Standard /V 1 /R 2 /P 4294967252 >>');
    expect(inspectPdfEncryption(pdf)).toEqual({ encrypted: true, filter: 'Standard', v: 1, r: 2, p: -44 });
  });

  it('reads an indirect Encrypt dictionary through the cross-reference table', () => {
    const pdf = handBuilt('/Encrypt 2 0 R');
    expect(inspectPdfEncryption(pdf)).toEqual({ encrypted: true, filter: 'Standard', v: 1, r: 2, p: -44 });
  });

  it('reports encryption even when the Encrypt dictionary cannot be resolved', () => {
    expect(inspectPdfEncryption(handBuilt('/Encrypt 9 0 R'))).toEqual({ encrypted: true });
  });

  it('honours a byte offset that counts from a %PDF header behind a junk prefix', () => {
    const prefix = 'JUNKJUNK\n';
    const pdf = handBuilt('/Encrypt 2 0 R', prefix);
    expect(inspectPdfEncryption(pdf).encrypted).toBe(true);
  });
});

describe('inspectPdfEncryption on hostile or malformed input', () => {
  it('rejects a file without a startxref with a typed 400', () => {
    const run = () => inspectPdfEncryption(Buffer.from('%PDF-1.7\n1 0 obj\n<< >>\nendobj\n'));
    expect(run).toThrow(PdfStructureError);
    expect(run).toThrow(/startxref/);
  });

  it('rejects a startxref that points outside the file', () => {
    expect(() => inspectPdfEncryption(Buffer.from('%PDF-1.7\nstartxref\n999999\n%%EOF\n'))).toThrow(PdfStructureError);
  });

  it('rejects a /Prev chain that loops, instead of following it forever', () => {
    const head = '%PDF-1.4\n';
    const xrefOffset = head.length;
    const pdf = Buffer.from(
      `${head}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev ${xrefOffset} >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
      'latin1'
    );
    expect(() => inspectPdfEncryption(pdf)).toThrow(PdfStructureError);
    expect(() => inspectPdfEncryption(pdf)).toThrow(/cross-reference chain/);
  });

  it('rejects an xref table whose entry count runs past the end of the file', () => {
    const pdf = Buffer.from(
      `%PDF-1.4\nxref\n0 99999999\n0000000000 65535 f \ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n`,
      'latin1'
    );
    expect(() => inspectPdfEncryption(pdf)).toThrow(PdfStructureError);
  });

  it('looks for startxref only in the last PDF_TRAILER_SCAN_BYTES of the file', async () => {
    const plain = await plainPdf();
    expect(inspectPdfEncryption(Buffer.concat([plain, Buffer.alloc(PDF_TRAILER_SCAN_BYTES / 2, 0x0a)]))).toEqual({ encrypted: false });
    expect(() => inspectPdfEncryption(Buffer.concat([plain, Buffer.alloc(PDF_TRAILER_SCAN_BYTES * 2, 0x0a)]))).toThrow(PdfStructureError);
  });

  it('rejects an empty buffer and non-PDF bytes with a typed 400', () => {
    expect(() => inspectPdfEncryption(Buffer.alloc(0))).toThrow(PdfStructureError);
    expect(() => inspectPdfEncryption(Buffer.from('plain text, not a pdf'))).toThrow(PdfStructureError);
  });
});

/** A file of `count` classic cross-reference sections, each naming the one before it in /Prev. */
function tableChain(count: number): Buffer {
  let body = '%PDF-1.4\n';
  let previous: number | undefined;
  for (let i = 0; i < count; i++) {
    const offset = Buffer.byteLength(body, 'latin1');
    body += `xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1${previous === undefined ? '' : ` /Prev ${previous}`} >>\n`;
    previous = offset;
  }
  return Buffer.from(`${body}startxref\n${previous}\n%%EOF\n`, 'latin1');
}

describe('the length of the /Prev chain', () => {
  it('follows a chain of exactly MAX_CROSS_REFERENCE_SECTIONS distinct sections', () => {
    expect(inspectPdfEncryption(tableChain(MAX_CROSS_REFERENCE_SECTIONS))).toEqual({ encrypted: false });
  });

  it('refuses a chain of one more distinct section with a typed 400, so a long chain is never followed to its end', () => {
    const chain = tableChain(MAX_CROSS_REFERENCE_SECTIONS + 1);
    expect(() => inspectPdfEncryption(chain)).toThrow(PdfStructureError);
    expect(() => inspectPdfEncryption(chain)).toThrow(/more than 64 sections/);
  });
});

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;
const CHILD = path.join(__dirname, 'pdf-encryption-child.ts');
const ROOT = path.resolve(__dirname, '..');
/** Rows of the hostile cross-reference streams: each inflates to about 8 MiB and is a few kilobytes packed. */
const HOSTILE_STREAM_BYTES = 8 * MIB;
const HOSTILE_SECTIONS = 64;
const HOSTILE_COLUMNS = 5;
/** The decoded bytes one inspection may spend over all its cross-reference streams. */
const MAX_RSS_GROWTH_BYTES = 96 * MIB;
const MAX_ELAPSED_MS = 3000;

/** 64 Flate cross-reference streams that each inflate to the limit, with an /Encrypt reference no section lists. */
function hostileXrefChain(): Buffer {
  const rowBytes = HOSTILE_COLUMNS + 1;
  const rows = Math.floor(HOSTILE_STREAM_BYTES / rowBytes);
  const raw = Buffer.alloc(rows * rowBytes);
  for (let row = 0; row < rows; row++) raw[row * rowBytes] = 2;
  const packed = deflateSync(raw, { level: 9 });
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')];
  let length = parts[0].length;
  let previous: number | undefined;
  for (let i = 0; i < HOSTILE_SECTIONS; i++) {
    const offset = length;
    const entries = [
      `/Type /XRef /Size ${rows} /W [1 3 1] /Filter /FlateDecode`,
      `/DecodeParms << /Predictor 12 /Columns ${HOSTILE_COLUMNS} >> /Length ${packed.length}`,
      previous === undefined ? '' : `/Prev ${previous}`,
      i === HOSTILE_SECTIONS - 1 ? '/Encrypt 9999999 0 R' : '',
    ];
    const chunk = Buffer.concat([
      Buffer.from(`${100 + i} 0 obj\n<< ${entries.join(' ')} >>\nstream\n`, 'latin1'),
      packed,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    length += chunk.length;
    previous = offset;
  }
  parts.push(Buffer.from(`startxref\n${previous}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

describe('a hostile cross-reference stream chain', () => {
  it('is refused with a typed 413 within a small memory and time budget, in a fresh process', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-571-hostile-'));
    try {
      const file = path.join(dir, 'hostile.pdf');
      const bytes = hostileXrefChain();
      fs.writeFileSync(file, bytes);
      expect(bytes.length).toBeLessThan(2 * MIB);

      const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', CHILD, file], { cwd: ROOT, timeout: 120_000, maxBuffer: 4 * MIB });
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('RESULT:'));
      const outcome = JSON.parse((line ?? '').slice('RESULT:'.length)) as {
        error: { name: string; status?: number } | null;
        elapsedMs: number;
        rssGrowthBytes: number;
      };
      expect(outcome.error).toMatchObject({ name: 'DecompressionLimitError', status: 413 });
      expect(outcome.rssGrowthBytes).toBeLessThan(MAX_RSS_GROWTH_BYTES);
      expect(outcome.elapsedMs).toBeLessThan(MAX_ELAPSED_MS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
