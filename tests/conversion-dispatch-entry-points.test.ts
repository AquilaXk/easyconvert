import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { NextRequest } from 'next/server';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { processGraphNodeJob } from '../src/lib/queue/graph/node-executor';
import { processConversionJob } from '../src/lib/queue/conversion-queue';
import type { Job } from '../src/lib/queue/bullmq-engine';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { EngineUnavailableError } from '../src/lib/types';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';
import { HAS_PDFTOTEXT, HAS_SOFFICE, withMissingBinary } from './helpers/native-tools';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';

/**
 * Every entry point resolves conversions through the shared dispatcher. Spreadsheet formula
 * recalculation needs LibreOffice and has no in-process path, so with LibreOffice missing each
 * entry point must fail with EngineUnavailableError (HTTP 503) instead of silently converting
 * without recalculation.
 */

const ENGINE_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/engine-unavailable';
const HTTP_SERVICE_UNAVAILABLE = 503;
const ARTIFACT_TTL_MS = 60 * 60 * 1000;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RECALCULATE = JSON.stringify({ recalculate: true });

const UNITS = 1234;
const PRICE = 7;
const STALE_TOTAL = 0;

/**
 * A one-sheet workbook whose Total cell holds the formula B1*B2 with a stale cached value of 0.
 * Only an engine that recalculates formulas renders the real product.
 */
async function buildStaleFormulaXlsx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Totals" sheetId="1" r:id="rId1"/></sheets></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>Units</t></is></c><c r="B1"><v>${UNITS}</v></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>Price</t></is></c><c r="B2"><v>${PRICE}</v></c></row>` +
      `<row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3"><f>B1*B2</f><v>${STALE_TOTAL}</v></c></row>` +
      '</sheetData></worksheet>'
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

let SAMPLE_XLSX: Buffer;
beforeAll(async () => {
  SAMPLE_XLSX = await buildStaleFormulaXlsx();
});

let secretKey: string;
let userId: string;

beforeEach(async () => {
  const user = await userStore.createUser({
    name: 'Dispatch Tester',
    email: `dispatch_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  userId = user.id;
  const key = await redisKeyStore.generateApiKey(user.id, 'Dispatch Test Key', { scopes: ['convert:write', 'convert:read'] });
  secretKey = key.secretKey;
});

function multipart(url: string, fields: Record<string, string | Blob>, fileName?: string): NextRequest {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value instanceof Blob) form.append(name, value, fileName);
    else form.append(name, value);
  }
  return new NextRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: form });
}

function xlsxBlob(): Blob {
  return new Blob([new Uint8Array(SAMPLE_XLSX)], { type: XLSX_MIME });
}

async function expectEngineUnavailableProblem(res: Response): Promise<void> {
  expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  expect(res.headers.get('content-type')).toContain('application/problem+json');
  const problem = await res.json();
  expect(problem.type).toBe(ENGINE_UNAVAILABLE_TYPE);
  expect(problem.status).toBe(HTTP_SERVICE_UNAVAILABLE);
  expect(problem.detail).toMatch(/^Engine 'soffice' is unavailable: /);
}

let graphSeq = 0;

function convertNodeJob(storageKey: string): Job<ConversionJobData, ConversionJobResult> {
  graphSeq += 1;
  const graphId = `g_dispatch_${Date.now()}_${graphSeq}`;
  return {
    id: `${graphId}:n1`,
    data: {
      jobId: `${graphId}:n1`,
      sourceFormat: 'xlsx',
      targetFormat: 'pdf',
      fileSize: SAMPLE_XLSX.length,
      options: {},
      graphId,
      graphNodeId: 'n1',
      graphNode: { op: 'convert', targetFormat: 'pdf', options: { recalculate: true } },
      inputArtifacts: [storageKey],
    },
    opts: { attempts: 1 },
    attemptsMade: 1,
    signal: new AbortController().signal,
    log: async () => {},
    updateProgress: async () => {},
  } as unknown as Job<ConversionJobData, ConversionJobResult>;
}

function seedXlsx(): string {
  const key = `tests/conversion-dispatch/${Date.now()}_${graphSeq}_sheet.xlsx`;
  s3Storage.saveObject(key, SAMPLE_XLSX, XLSX_MIME, 'sheet.xlsx', ARTIFACT_TTL_MS);
  return key;
}

describe('entry points fail with 503 when the native engine a pair needs is missing', () => {
  it('POST /api/v1/convert (sync) returns an engine-unavailable problem and keeps the quota', async () => {
    const quotaBefore = await redisKeyStore.getQuotaUsage(userId);
    const res = await withMissingBinary('SOFFICE_PATH', () =>
      v1ConvertPost(
        multipart('http://localhost/api/v1/convert', { file: xlsxBlob(), targetFormat: 'pdf', options: RECALCULATE }, 'sheet.xlsx')
      )
    );
    await expectEngineUnavailableProblem(res);
    const quotaAfter = await redisKeyStore.getQuotaUsage(userId);
    expect(quotaAfter.usedToday).toBe(quotaBefore.usedToday);
  });

  it('POST /api/convert returns an engine-unavailable problem', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () =>
      convertPost(multipart('http://localhost/api/convert', { file: xlsxBlob(), targetFormat: 'pdf', options: RECALCULATE }, 'sheet.xlsx'))
    );
    await expectEngineUnavailableProblem(res);
  });

  it('POST /api/convert/batch returns an engine-unavailable problem', async () => {
    const res = await withMissingBinary('SOFFICE_PATH', () =>
      batchPost(
        multipart(
          'http://localhost/api/convert/batch',
          { files: xlsxBlob(), targetFormats: JSON.stringify({ default: 'pdf' }), options: RECALCULATE },
          'sheet.xlsx'
        )
      )
    );
    await expectEngineUnavailableProblem(res);
  });

  it('a graph convert node with the default engine rejects with EngineUnavailableError', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () => processGraphNodeJob(convertNodeJob(seedXlsx()), undefined, s3Storage));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
    await expect(run).rejects.toThrow(/^Engine 'soffice' is unavailable: Spreadsheet formula recalculation requires /);
  });

  it('a graph convert node on the in-process queue rejects with EngineUnavailableError', async () => {
    const run = withMissingBinary('SOFFICE_PATH', () => processConversionJob(convertNodeJob(seedXlsx())));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'soffice' });
    await expect(run).rejects.toThrow(/^Engine 'soffice' is unavailable: Spreadsheet formula recalculation requires /);
  });
});

describe.skipIf(!HAS_SOFFICE || !HAS_PDFTOTEXT)('entry points convert through LibreOffice when it is installed (needs soffice, pdftotext)', () => {
  it('POST /api/v1/convert (sync) recalculates the sheet natively into a PDF', async () => {
    const req = multipart(
      'http://localhost/api/v1/convert?raw=true',
      { file: xlsxBlob(), targetFormat: 'pdf', options: RECALCULATE },
      'sheet.xlsx'
    );
    const res = await v1ConvertPost(req);
    expect(res.status).toBe(200);
    const pdf = Buffer.from(await res.arrayBuffer());
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = extractTextWithExternalPdftotext(pdf) ?? '';
    const tokens = text.split(/\s+/).filter(Boolean);
    expect(tokens).toEqual(expect.arrayContaining(['Units', 'Total', String(UNITS), String(UNITS * PRICE)]));
  }, 120_000);
});
