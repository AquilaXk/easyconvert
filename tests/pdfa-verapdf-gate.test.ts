import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { oracleTest } from './helpers/oracle-test';
import { OracleToolMissingError, getOracleToolPath, type ExternalOracleTool } from './helpers/differential-oracle';
import { buildDocxWithJpeg, buildTextDocx, makeNoisyJpeg } from './helpers/office-jpeg-fixtures';
import { withMissingBinary } from './helpers/native-tools';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { verifyPdfA } from '../src/lib/conversions/pdf-postprocess';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { EngineUnavailableError, PdfAValidationError, type PdfAConformance } from '../src/lib/types';

/**
 * A PDF/A request is only answered with a file veraPDF validated against the requested flavour.
 * Verdicts are read back by running veraPDF directly on the output, with a reader written here.
 * Without veraPDF the request fails with 503; a file that fails validation fails with 422 and
 * the failed rule IDs.
 */

const CONVERT_TIMEOUT_MS = 180_000;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_UNPROCESSABLE = 422;
const HTTP_OK = 200;
const ENGINE_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/engine-unavailable';
const VERAPDF_TIMEOUT_MS = 120_000;
/** veraPDF flavour that validates each requested level. */
const FLAVOUR: Record<PdfAConformance, string> = { 'pdfa-1b': '1b', 'pdfa-2b': '2b', 'pdfa-3b': '3b' };
/**
 * PDF/A-1b is not in this list: LibreOffice 24.2 writes a different Info CreationDate and
 * xmp:CreateDate in PDF/A-1 output (rule 6.7.3-1), so a 1b export is judged by the conditional
 * test at the end of the file instead of being expected to pass.
 */
const LEVELS: PdfAConformance[] = ['pdfa-2b', 'pdfa-3b'];
/** Rule 6.2.11.4.1 test 1 of ISO 19005-2: every font program is embedded. A standard font is not. */
const FONT_NOT_EMBEDDED_RULE = '6.2.11.4.1-1';
const KOREAN_PARAGRAPHS = ['한글 문서 보관 테스트입니다.', '국제 표준 보존 형식으로 변환합니다.'];
const SOFFICE_TOOLS: ExternalOracleTool[] = ['soffice'];
const SOFFICE_VERAPDF_TOOLS: ExternalOracleTool[] = ['soffice', 'verapdf'];

let workDir: string;
let docx: Buffer;

function tool(name: ExternalOracleTool): string {
  const resolved = getOracleToolPath(name);
  if (!resolved) throw new OracleToolMissingError(name);
  return resolved;
}

interface IndependentVerdict {
  compliant: boolean;
  failedRules: string[];
}

/** Runs veraPDF on a file and reads the JSON report; independent of the module under test. */
function runVerapdf(pdfPath: string, flavour: string): IndependentVerdict {
  let stdout: string;
  try {
    stdout = execFileSync(tool('verapdf'), ['--flavour', flavour, '--format', 'json', pdfPath], {
      encoding: 'utf-8',
      timeout: VERAPDF_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    stdout = (err as { stdout?: string }).stdout ?? '';
  }
  const result = JSON.parse(stdout).report.jobs[0].validationResult[0];
  const summaries = (result.details?.ruleSummaries ?? []) as { clause: string; testNumber: number; status: string }[];
  return {
    compliant: result.compliant,
    failedRules: summaries.filter((rule) => rule.status === 'failed').map((rule) => `${rule.clause}-${rule.testNumber}`),
  };
}

function writePdf(name: string, pdf: Buffer): string {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, pdf);
  return file;
}

/** A PDF whose XMP claims PDF/A-2b but whose only font is the non-embedded standard Helvetica. */
async function identifiedButNonConformingPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  page.drawText('archival', { x: 20, y: 100, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
    '<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  return Buffer.from(await doc.save());
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-verapdf-gate-'));
  docx = await buildDocxWithJpeg(await makeNoisyJpeg());
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('PDF/A needs a validator', () => {
  it('answers with an engine-unavailable error when veraPDF is not installed', async () => {
    const pdf = await identifiedButNonConformingPdf();
    const run = withMissingBinary('VERAPDF_PATH', () => verifyPdfA(pdf, 'pdfa-2b'));

    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'verapdf' });
  });
});

describe('PDF/A validation with veraPDF', () => {
  oracleTest(
    'rejects a file that fails a rule with a 422 error that lists the failed rule IDs',
    ['verapdf'],
    async () => {
      const pdf = await identifiedButNonConformingPdf();
      const independent = runVerapdf(writePdf('negative.pdf', pdf), '2b');
      expect(independent.compliant).toBe(false);
      expect(independent.failedRules).toContain(FONT_NOT_EMBEDDED_RULE);

      const error = await verifyPdfA(pdf, 'pdfa-2b').then(
        () => {
          throw new Error('verifyPdfA accepted a non-conforming file');
        },
        (err: unknown) => err
      );

      expect(error).toBeInstanceOf(PdfAValidationError);
      const validation = error as PdfAValidationError;
      expect(validation.status).toBe(HTTP_UNPROCESSABLE);
      expect(validation.profile).toBe('pdfa-2b');
      expect([...validation.failedRules].sort()).toEqual([...independent.failedRules].sort());
      expect(validation.message).toContain(FONT_NOT_EMBEDDED_RULE);
    }
  );

  for (const level of LEVELS) {
    oracleTest(
      `docx to ${level} passes veraPDF and reports the verdict in the result metadata`,
      SOFFICE_VERAPDF_TOOLS,
      async () => {
        const result = await dispatchConversion(docx, 'docx', 'pdf', { pdfa: { conformance: level } }, 'fx.docx');

        expect(result.metadata).toMatchObject({ pdfaValidated: true, pdfaProfile: level });
        const verdict = runVerapdf(writePdf(`docx-${level}.pdf`, result.buffer), FLAVOUR[level]);
        expect(verdict).toEqual({ compliant: true, failedRules: [] });
      },
      CONVERT_TIMEOUT_MS
    );
  }

  oracleTest(
    'a PDF input converted to PDF/A passes veraPDF and reports the verdict in the result metadata',
    SOFFICE_VERAPDF_TOOLS,
    async () => {
      const plain = await dispatchConversion(docx, 'docx', 'pdf', {}, 'fx.docx');
      const result = await dispatchConversion(
        plain.buffer,
        'pdf',
        'pdf',
        { pdfa: { conformance: 'pdfa-2b' } },
        'fx.pdf'
      );

      expect(result.metadata).toMatchObject({ pdfaValidated: true, pdfaProfile: 'pdfa-2b' });
      expect(runVerapdf(writePdf('pdf-input.pdf', result.buffer), '2b')).toEqual({ compliant: true, failedRules: [] });
    },
    CONVERT_TIMEOUT_MS
  );
});

/**
 * LibreOffice's PDF/A-1b export of Korean text is not always conforming (the CID font subset lacks a
 * CIDSet in some builds). The expected verdict is therefore taken from a direct LibreOffice export
 * validated by veraPDF; the API must agree with it: a 200 for a conforming export, otherwise a 422
 * that names exactly the rules veraPDF reports.
 */
describe('POST /api/v1/convert with a PDF/A request', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'PDF/A Gate Tester',
      email: `pdfa_gate_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'PDF/A Gate Key', { scopes: ['convert:write', 'convert:read'] });
    secretKey = key.secretKey;
  });

  function convertRequest(file: Buffer, fileName: string, targetFormat: string, options?: object): NextRequest {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file)]), fileName);
    form.append('targetFormat', targetFormat);
    if (options) form.append('options', JSON.stringify(options));
    return new NextRequest('http://localhost/api/v1/convert', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}` },
      body: form,
    });
  }


  oracleTest(
    'maps a missing veraPDF to HTTP 503 on a docx to PDF/A request',
    SOFFICE_TOOLS,
    async () => {
      const res = await withMissingBinary('VERAPDF_PATH', () =>
        v1ConvertPost(convertRequest(docx, 'fx.docx', 'pdf', { pdfa: { conformance: 'pdfa-2b' } }))
      );

      expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
      const problem = await res.json();
      expect(problem.type).toBe(ENGINE_UNAVAILABLE_TYPE);
      expect(problem.detail).toContain("Engine 'verapdf' is unavailable");
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'answers 422 with the failed rule IDs, or 200, exactly as veraPDF judges the LibreOffice export',
    SOFFICE_VERAPDF_TOOLS,
    async () => {
      const koreanDocx = await buildTextDocx(KOREAN_PARAGRAPHS);
      const input = path.join(workDir, 'korean.docx');
      fs.writeFileSync(input, koreanDocx);
      const outDir = path.join(workDir, 'korean-out');
      const filter =
        'pdf:writer_pdf_Export:{"ReduceImageResolution":{"type":"boolean","value":"false"},' +
        '"Quality":{"type":"long","value":"100"},"ExportBookmarks":{"type":"boolean","value":"true"},' +
        '"SelectPdfVersion":{"type":"long","value":"1"}}';
      execFileSync(
        tool('soffice'),
        [
          '--headless',
          '--norestore',
          `-env:UserInstallation=file://${path.join(workDir, 'profile')}`,
          '--convert-to',
          filter,
          '--outdir',
          outDir,
          input,
        ],
        { timeout: VERAPDF_TIMEOUT_MS, stdio: 'ignore' }
      );
      const expected = runVerapdf(path.join(outDir, 'korean.pdf'), '1b');

      const res = await v1ConvertPost(convertRequest(koreanDocx, 'korean.docx', 'pdf', { pdfa: { conformance: 'pdfa-1b' } }));

      if (expected.compliant) {
        expect(res.status).toBe(HTTP_OK);
        return;
      }
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const problem = await res.json();
      expect([...problem.failedRules].sort()).toEqual([...expected.failedRules].sort());
      expect(problem.detail).toContain(expected.failedRules[0]);
    },
    CONVERT_TIMEOUT_MS
  );
});
