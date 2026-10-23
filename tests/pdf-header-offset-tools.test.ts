import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildPhotoPdf } from '../bench/pdf-photo';
import { hasPdfHeader, pdfFromHeader } from '../src/lib/format-signatures';
import { assertNotSpoofedFile } from '../src/lib/security/file-guard';
import { compressPdf, convertToPdfA } from '../src/lib/conversions/pdf-postprocess';
import { getGhostscriptBinaryPath } from '../src/lib/conversions/pdf-postprocess/gs-path';
import { pdftotext, qpdfCheckPasses } from './helpers/encrypted-pdf-fixtures';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Bytes in front of the `%PDF-` header and the tools that dispatch on the first bytes of a file. pdf.js (`moveStart`
 * after `checkHeader`) and qpdf treat the header as the start of the file, and the cross-reference offsets count from
 * it, so a tool that does not search for the header itself is handed the file from the header on. Ghostscript decides
 * between PDF and PostScript from the first bytes: a file that opens with a line break and `%!PS` is a PostScript
 * program to it and a PDF to qpdf and Poppler.
 */

const GHOSTSCRIPT_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: GHOSTSCRIPT_TIMEOUT_MS });

const compressMissing =
  skipWithoutTools('qpdf', 'pdftotext') || skipUnless('Ghostscript (gs)', getGhostscriptBinaryPath() !== null);

const PHOTO = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'photo-a.jpg'));
const PAGE_TEXT = 'Photograph page 1 of one';
const PS_TEXT = 'PSPROGRAMMARK';
const HEADER_LINE = '%PDF-1.4\n';
/** What a PostScript interpreter runs and a PDF reader skips: it follows the header line and opens a string over the rest of the file. */
const POSTSCRIPT_PROGRAM = Buffer.from(`/Helvetica findfont 20 scalefont setfont 20 100 moveto (${PS_TEXT}) show showpage\n(\n`, 'latin1');
const OFFSET_ENTRY = /(\d{10}) (\d{5}) n /g;
const STARTXREF = /startxref\n(\d+)/;

const photoPdf = (): Buffer =>
  buildPhotoPdf({ jpeg: PHOTO, pageWidth: 612, pageHeight: 792, pages: [{ text: PAGE_TEXT, photoWidthPoints: 200 }] });

/** `pdf` with `inserted` after its header line and every cross-reference offset moved to match, so offsets still count from the header. */
function withInsertedAfterHeader(pdf: Buffer, inserted: Buffer): Buffer {
  const at = HEADER_LINE.length;
  expect(pdf.subarray(0, at).toString('latin1')).toBe(HEADER_LINE);
  const text = pdf.toString('latin1');
  const shifted = text
    .replace(OFFSET_ENTRY, (_entry, offset: string, generation: string) => `${String(Number(offset) + inserted.length).padStart(10, '0')} ${generation} n `)
    .replace(STARTXREF, (_match, offset: string) => `startxref\n${Number(offset) + inserted.length}`);
  const bytes = Buffer.from(shifted, 'latin1');
  return Buffer.concat([bytes.subarray(0, at), inserted, bytes.subarray(at)]);
}

const postscriptWrapped = (lead: string): Buffer =>
  Buffer.concat([Buffer.from(lead, 'latin1'), withInsertedAfterHeader(photoPdf(), POSTSCRIPT_PROGRAM)]);

describe('pdfFromHeader', () => {
  const body = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF\n', 'latin1');

  it('returns the very same buffer when the header is at byte 0', () => {
    expect(pdfFromHeader(body)).toBe(body);
  });

  it('returns a view of the same memory, starting at the header, when bytes come first', () => {
    const lead = Buffer.from('\r\n', 'latin1');
    const prefixed = Buffer.concat([lead, body]);
    const trimmed = pdfFromHeader(prefixed);
    expect(trimmed.equals(body)).toBe(true);
    expect(trimmed.buffer).toBe(prefixed.buffer);
    expect(trimmed.byteOffset).toBe(prefixed.byteOffset + lead.length);
  });

  it('takes the first header when the file holds more than one', () => {
    const doubled = Buffer.concat([Buffer.from('\n', 'latin1'), body, body]);
    expect(pdfFromHeader(doubled).equals(Buffer.concat([body, body]))).toBe(true);
  });

  it('returns the buffer unchanged when no header lies in the first 1,024 bytes', () => {
    const none = Buffer.from('%!PS-Adobe-3.0\nshowpage\n', 'latin1');
    expect(pdfFromHeader(none)).toBe(none);
    const late = Buffer.concat([Buffer.alloc(1024, 0x20), body]);
    expect(hasPdfHeader(late)).toBe(false);
    expect(pdfFromHeader(late)).toBe(late);
  });
});

describe.skipIf(compressMissing)('Ghostscript receives the file from the %PDF- header on', () => {
  const textOf = (pdf: Buffer): string => pdftotext(pdf).replace(/\s+/g, ' ').trim();

  for (const [name, lead] of [
    ['a line feed', '\n%!PS-Adobe-3.0\n'],
    ['an end-of-transmission byte', '\x04%!PS-Adobe-3.0\n'],
  ] as const) {
    it(`compresses the PDF, not the PostScript program, of a file that opens with ${name} and a PostScript comment`, async () => {
      const wrapped = postscriptWrapped(lead);
      expect(() => assertNotSpoofedFile(wrapped, 'pdf', 'wrapped.pdf')).not.toThrow();
      expect(textOf(wrapped)).toBe(PAGE_TEXT);

      const result = await compressPdf(wrapped, { profile: 'web' });

      expect(result.optimized).toBe(true);
      expect(qpdfCheckPasses(result.buffer)).toBe(true);
      expect(textOf(result.buffer)).toBe(PAGE_TEXT);
      expect(result.buffer.toString('latin1')).not.toContain(PS_TEXT);
    });
  }

  it('still compresses a real file that a CR LF precedes', async () => {
    const plain = photoPdf();
    const prefixed = Buffer.concat([Buffer.from('\r\n', 'latin1'), plain]);

    const result = await compressPdf(prefixed, { profile: 'web' });

    expect(result.optimized).toBe(true);
    expect(result.buffer.length).toBeLessThan(prefixed.length * 0.5);
    expect(qpdfCheckPasses(result.buffer)).toBe(true);
    expect(textOf(result.buffer)).toBe(PAGE_TEXT);
  });
});

describe('LibreOffice receives the file from the %PDF- header on', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-header-offset-'));
  afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

  /** A PDF/A-1b-identified document, which the stand-in converter returns as its output. */
  async function identifiedOutput(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage([200, 200]).drawText('converted', { x: 20, y: 100, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
    const xmp =
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
      'xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part>' +
      '<pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })));
    return Buffer.from(await doc.save());
  }

  function script(name: string, body: string): string {
    const file = path.join(workDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  /** Runs `convertToPdfA` on `input` with converter and validator stand-ins, and returns the bytes the converter was given. */
  async function bytesTheConverterReceives(input: Buffer): Promise<Buffer> {
    const output = path.join(workDir, 'identified.pdf');
    fs.writeFileSync(output, await identifiedOutput());
    const received = path.join(workDir, `received-${Math.random().toString(16).slice(2)}.pdf`);
    const converter = script(
      'soffice-recording',
      `for a in "$@"; do prev2="$prev"; prev="$a"; [ "$prev2" = "--outdir" ] && out="$a"; done; in="$prev"\n` +
        `cp "$in" "${received}"\ncp "${output}" "$out/$(basename "$in")"`
    );
    const validator = script('verapdf-passing', `echo '{"report":{"jobs":[{"validationResult":[{"compliant":true}]}]}}'`);
    const saved = { SOFFICE_PATH: process.env.SOFFICE_PATH, VERAPDF_PATH: process.env.VERAPDF_PATH };
    process.env.SOFFICE_PATH = converter;
    process.env.VERAPDF_PATH = validator;
    try {
      await convertToPdfA(input, { conformance: 'pdfa-1b' });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    return fs.readFileSync(received);
  }

  it('hands the converter a file that opens with the header when bytes come first', async () => {
    const wrapped = postscriptWrapped('\n%!PS-Adobe-3.0\n');
    expect((await bytesTheConverterReceives(wrapped)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('hands the converter the bytes of a file whose header is at byte 0 unchanged', async () => {
    const plain = photoPdf();
    expect((await bytesTheConverterReceives(plain)).equals(plain)).toBe(true);
  });
});
