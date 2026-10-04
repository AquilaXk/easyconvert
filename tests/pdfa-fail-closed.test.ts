import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { oracleTest } from './helpers/oracle-test';
import { getOracleToolPath, OracleToolMissingError } from './helpers/differential-oracle';
import { convertToPdfA, parseVerapdfReport } from '../src/lib/conversions/pdf-postprocess/pdfa';
import { convertFile } from '../src/lib/conversions';
import { PdfPostprocessError, UnsupportedOptionError } from '../src/lib/types';

/**
 * PDF/A output must be a converted, PDF/A-identified file: a converter that writes nothing or
 * echoes its input, or a validator that reports non-compliance, has to fail the request.
 */

/** `pdffonts` prints a column header line and a dashed rule before the font rows. */
const FONT_TABLE_HEADER_LINES = 2;
/** Position of the `emb` column counted from the end of a `pdffonts` row. */
const EMB_COLUMN_FROM_END = 5;

let workDir: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string): void {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  process.env[name] = value;
}

/** Writes an executable shell script and returns its path. */
function script(name: string, body: string): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

async function samplePdf(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText(text, { x: 20, y: 100, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  return Buffer.from(await doc.save());
}

/** A PDF whose catalog carries an XMP packet identifying it as PDF/A-<part><conformance>. */
async function pdfWithPdfAId(part: number, conformance: string): Promise<Buffer> {
  const doc = await PDFDocument.load(await samplePdf('archival'));
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
    `<pdfaid:part>${part}</pdfaid:part><pdfaid:conformance>${conformance}</pdfaid:conformance>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return Buffer.from(await doc.save());
}

/** A fake converter that copies `source` into the `--outdir` it receives as the output. */
function fakeConverterCopying(source: string): string {
  return script(
    `soffice-copy-${path.basename(source)}`,
    `out=""; prev=""; for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; prev="$a"; done; in="$a"\n` +
      `cp "${source}" "$out/$(basename "$in")"`
  );
}

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-fail-closed-'));
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete savedEnv[name];
  }
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('convertToPdfA fails closed', () => {
  it('rejects a converter run that produced no output file', async () => {
    setEnv('SOFFICE_PATH', script('soffice-silent', 'exit 0'));
    setEnv('VERAPDF_PATH', '');
    await expect(convertToPdfA(await samplePdf('no output'), { conformance: 'pdfa-1b' })).rejects.toThrow(
      PdfPostprocessError
    );
  });

  it('rejects output that is the unconverted input', async () => {
    // The input already carries the requested PDF/A-1B identification, so only the
    // identical-output check can reject the echoed file.
    const input = await pdfWithPdfAId(1, 'B');
    const inputCopy = path.join(workDir, 'echo-source.pdf');
    fs.writeFileSync(inputCopy, input);
    setEnv('SOFFICE_PATH', fakeConverterCopying(inputCopy));
    setEnv('VERAPDF_PATH', '');
    await expect(convertToPdfA(input, { conformance: 'pdfa-1b' })).rejects.toThrow(/not converted/);
  });

  it('rejects output identified as a different PDF/A part than requested', async () => {
    const wrongPart = path.join(workDir, 'part2.pdf');
    fs.writeFileSync(wrongPart, await pdfWithPdfAId(2, 'B'));
    setEnv('SOFFICE_PATH', fakeConverterCopying(wrongPart));
    setEnv('VERAPDF_PATH', '');
    await expect(convertToPdfA(await samplePdf('wrong part'), { conformance: 'pdfa-1b' })).rejects.toThrow(
      /PDF\/A identification/
    );
  });

  it('returns identified output and reports it as unvalidated when no validator is installed', async () => {
    const converted = await pdfWithPdfAId(1, 'B');
    const convertedPath = path.join(workDir, 'part1.pdf');
    fs.writeFileSync(convertedPath, converted);
    setEnv('SOFFICE_PATH', fakeConverterCopying(convertedPath));
    setEnv('VERAPDF_PATH', '');

    const result = await convertToPdfA(await samplePdf('identified'), { conformance: 'pdfa-1b' });
    expect(result.buffer.equals(converted)).toBe(true);
    expect(result.pdfaValidated).toBe(false);
    expect(result.conformanceLevel).toBe('pdfa-1b');
  });

  it('rejects output the validator reports as non-compliant', async () => {
    const convertedPath = path.join(workDir, 'part1-noncompliant.pdf');
    fs.writeFileSync(convertedPath, await pdfWithPdfAId(1, 'B'));
    setEnv('SOFFICE_PATH', fakeConverterCopying(convertedPath));
    setEnv(
      'VERAPDF_PATH',
      script('verapdf-fail', `echo '{"report":{"jobs":[{"validationResult":[{"compliant":false,"profileName":"PDF/A-1B"}]}]}}'`)
    );
    await expect(convertToPdfA(await samplePdf('validated'), { conformance: 'pdfa-1b' })).rejects.toThrow(
      /not PDF\/A compliant/
    );
  });

  it('marks output as validated when the validator reports compliance', async () => {
    const convertedPath = path.join(workDir, 'part1-compliant.pdf');
    fs.writeFileSync(convertedPath, await pdfWithPdfAId(1, 'B'));
    setEnv('SOFFICE_PATH', fakeConverterCopying(convertedPath));
    setEnv(
      'VERAPDF_PATH',
      script('verapdf-pass', `echo '{"report":{"jobs":[{"validationResult":[{"compliant":true,"profileName":"PDF/A-1B"}]}]}}'`)
    );
    const result = await convertToPdfA(await samplePdf('validated'), { conformance: 'pdfa-1b' });
    expect(result.pdfaValidated).toBe(true);
  });
});

describe('parseVerapdfReport', () => {
  it('reads compliance from array and object validation results', () => {
    expect(parseVerapdfReport('{"report":{"jobs":[{"validationResult":[{"compliant":true}]}]}}')).toBe(true);
    expect(parseVerapdfReport('{"report":{"jobs":[{"validationResult":[{"compliant":true},{"compliant":false}]}]}}')).toBe(false);
    expect(parseVerapdfReport('{"report":{"jobs":[{"validationResult":{"isCompliant":true}}]}}')).toBe(true);
    expect(parseVerapdfReport('{"report":{"jobs":[{"validationResult":{"isCompliant":false}}]}}')).toBe(false);
  });

  it('throws on a report without a validation result instead of guessing', () => {
    expect(() => parseVerapdfReport('{"report":{"jobs":[{"itemDetails":{"passed":true}}]}}')).toThrow(PdfPostprocessError);
    expect(() => parseVerapdfReport('not json')).toThrow(PdfPostprocessError);
  });
});

describe('PDF post-processing order', () => {
  it('refuses to encrypt PDF/A output, which ISO 19005 forbids', async () => {
    await expect(
      convertFile(Buffer.from('Archival text\n'), 'txt', 'pdf', { pdfa: { conformance: 'pdfa-1b' }, protect: { userPassword: 'x' } }, 'a.txt')
    ).rejects.toThrow(UnsupportedOptionError);
  });
});

/**
 * PDF input reaches PDF/A through LibreOffice Draw's PDF import. A LibreOffice install without
 * Draw has no such filter, so these tests skip (and fail under ORACLE_STRICT_MODE) there.
 */
function requireLibreOfficeDraw(): void {
  const soffice = fs.realpathSync(getOracleToolPath('soffice') as string);
  const drawRegistry = path.join(path.dirname(soffice), '..', 'share', 'registry', 'draw.xcd');
  if (!fs.existsSync(drawRegistry)) {
    throw new OracleToolMissingError('libreoffice-draw', `LibreOffice Draw is not installed (${drawRegistry} missing)`);
  }
}

describe('real LibreOffice conversion', () => {
  oracleTest('identifies the converted file as the requested PDF/A part', ['soffice', 'pdfinfo'], async () => {
    requireLibreOfficeDraw();
    const result = await convertToPdfA(await samplePdf('LibreOffice archival record'), { conformance: 'pdfa-2b' });
    const out = path.join(workDir, 'real-pdfa.pdf');
    fs.writeFileSync(out, result.buffer);
    const xmp = execFileSync('pdfinfo', ['-meta', out]).toString('utf-8');
    expect(xmp).toMatch(/pdfaid:part(?:>|=")2/);
    expect(xmp).toMatch(/pdfaid:conformance(?:>|=")B/i);
  }, 120_000);
});

describe('watermark before PDF/A', () => {
  oracleTest(
    'keeps the watermark inside the PDF/A output with every font embedded',
    ['soffice', 'pdftotext', 'pdffonts'],
    async () => {
      requireLibreOfficeDraw();
      // Horizontal so pdftotext reads the stamp in order; the default is diagonal.
      const watermark = 'CONFIDENTIAL DRAFT 7731';
      const result = await convertFile(
        Buffer.from('Quarterly archival record\n'),
        'txt',
        'pdf',
        { watermark: { type: 'text', text: watermark, rotation: 0 }, pdfa: { conformance: 'pdfa-2b' } },
        'record.txt'
      );
      const out = path.join(workDir, 'watermarked-pdfa.pdf');
      fs.writeFileSync(out, result.buffer);

      const text = execFileSync('pdftotext', [out, '-']).toString('utf-8').replace(/\s+/g, ' ');
      expect(text).toContain(watermark);
      // A watermark stamped after conversion uses a non-embedded standard font, which PDF/A forbids.
      const fontRows = execFileSync('pdffonts', [out]).toString('utf-8').trim().split('\n').slice(FONT_TABLE_HEADER_LINES);
      expect(fontRows.length).toBeGreaterThan(0);
      for (const row of fontRows) {
        const columns = row.trim().split(/\s+/);
        // Columns end with: emb sub uni objectNum generation.
        expect({ font: columns[0], embedded: columns[columns.length - EMB_COLUMN_FROM_END] }).toEqual({
          font: columns[0],
          embedded: 'yes',
        });
      }
    },
    120_000
  );
});
