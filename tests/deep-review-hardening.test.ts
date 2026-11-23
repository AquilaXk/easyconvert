import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readWorksheetStructure } from '../src/lib/conversions/office/xlsx-worksheet-structure';
import { convertOffice, parseDocxXml } from '../src/lib/conversions/office';
import { applyPdfWatermark, MAX_WATERMARK_TILES_PER_PAGE } from '../src/lib/conversions/pdf-postprocess/watermark';
import { parseSvgGeometries } from '../src/lib/conversions/svg-geometry';
import { CadGeometryUnavailableError, ConversionFailedError, PayloadLimitError } from '../src/lib/types';
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as toolJobsPost } from '../src/app/api/tools/jobs/route';
import { POST as credentialsPost } from '../src/app/api/v1/storage/credentials/route';
import { POST as directUploadPost } from '../src/app/api/v1/uploads/direct/route';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { hashPassword } from '../src/lib/auth/crypto';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { resetLoginRateLimiterStore } from '../src/lib/auth/login-rate-limiter';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { registerCompletedUpload } from '../src/lib/storage/retention-service';
import { s3Storage } from '../src/lib/storage/s3-storage';
import { acquireSyncSlot } from '../src/lib/queue/concurrency-limit';
import { InMemoryIdempotencyStore } from '../src/lib/api/idempotency';
import { IDEMPOTENCY_MAX_STORED_BODY_BYTES, storeCompletedResponse } from '../src/lib/api/with-idempotency';
import { JOB_STAGING_MAX_AGE_MS } from '../src/lib/storage/temp-file';
import { sweepWorkerSandboxDirs } from '../src/worker/sandbox-sweep';
import { expectNoHang } from './helpers/timing';

const BASE_URL = 'http://localhost:3000';
const createdKeys: string[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetLoginRateLimiterStore();
  for (const key of createdKeys.splice(0)) {
    s3Storage.deleteObject(key);
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function makeTestUserWithKey(tier: 'free' | 'paid' = 'paid') {
  const email = `harden_${crypto.randomBytes(6).toString('hex')}@hardening.test`;
  const user = await redisUserStore.createUser({
    email,
    name: 'Hardening User',
    tier,
    emailVerified: true,
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'hardening-key', {
    scopes: ['convert:write', 'convert:read', 'storage:download'],
  });
  return { user, apiKey: key.secretKey };
}

async function storeUserUpload(userId: string, filename: string, content: Buffer, mimeType = 'application/octet-stream'): Promise<string> {
  const init = await s3Storage.initiateMultipartUpload(filename, mimeType, content.length, userId);
  const part = await s3Storage.uploadPart(init.uploadId, 1, content);
  const done = await s3Storage.completeMultipartUpload(init.uploadId, [{ partNumber: 1, etag: part.etag }]);
  await registerCompletedUpload(s3Storage, done.key);
  createdKeys.push(done.key);
  return done.key;
}

describe('deep-review hardening: conversion engine bounds & XML/SVG parsing', () => {
  it.each([
    ['negative min', '<cols><col min="-2147483648" max="1" width="12"/></cols>', /before the first column/],
    ['zero min', '<cols><col min="0" max="2" width="12"/></cols>', /before the first column/],
    ['inverted range', '<cols><col min="5" max="2" width="12"/></cols>', /min greater than max/],
    ['past XFD max', '<cols><col min="1" max="16385" width="12"/></cols>', /past the last column/],
  ])('rejects XLSX %s column range before allocating columns', async (_label, colsXml, pattern) => {
    const sheetXml = `<worksheet>${colsXml}<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row></sheetData></worksheet>`;
    const caught = await expectNoHang('XLSX <col> bound', () => {
      try {
        readWorksheetStructure(sheetXml, 'Sheet1');
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(caught).toBeInstanceOf(ConversionFailedError);
    expect((caught as Error).message).toMatch(pattern);

    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types/>');
    zip.file(
      'xl/workbook.xml',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
    );
    zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
    zip.file('xl/worksheets/sheet1.xml', sheetXml);
    const xlsxBuffer = await zip.generateAsync({ type: 'nodebuffer' });

    const convErr = await expectNoHang('convertOffice XLSX <col> bound', () =>
      convertOffice(xlsxBuffer, 'xlsx', 'csv', {}, 'bad-col.xlsx').catch((err: unknown) => err)
    );
    expect(convErr).toBeInstanceOf(ConversionFailedError);
    expect((convErr as Error).message).toMatch(pattern);
  });

  it('rejects oversized DOCX <w:gridSpan w:val="999999999"/> before iterating', async () => {
    const xml =
      '<w:document><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="999999999"/></w:tcPr><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
    const caught = await expectNoHang('DOCX gridSpan bound', () => {
      try {
        parseDocxXml(xml);
        return undefined;
      } catch (error) {
        return error;
      }
    });
    expect(caught).toBeInstanceOf(PayloadLimitError);
    expect((caught as Error).message).toMatch(/1000 columns/);
  });

  it('rejects tiled PDF watermark over an oversized /MediaBox before drawing', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([2_000_000, 2_000_000]);
    const pdfBuffer = Buffer.from(await pdf.save());

    const failure = await expectNoHang('PDF tiled watermark cap', () =>
      applyPdfWatermark(pdfBuffer, { position: 'tile', text: 'WIDE' }).catch((err: unknown) => err)
    );
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toContain(String(MAX_WATERMARK_TILES_PER_PAGE));

    // Wide page below vertical startY must return immediately instead of spinning in the outer x loop.
    const wideShortPdf = await PDFDocument.create();
    wideShortPdf.addPage([1e20, 10]);
    const wideShortBuffer = Buffer.from(await wideShortPdf.save());
    const wideShortResult = await expectNoHang('PDF tiled watermark zero-height overlap', () =>
      applyPdfWatermark(wideShortBuffer, { position: 'tile', text: 'WIDE' })
    );
    expect(wideShortResult.length).toBeGreaterThan(0);
  });

  it('allows repeated <use> of a display="none" <symbol> while still rejecting true cycles and invalid XML char refs', () => {
    const hiddenSymbolTwice = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">',
      '<symbol id="sym" display="none"><rect width="10" height="10" fill="black"/></symbol>',
      '<use href="#sym" x="0" y="0"/>',
      '<use href="#sym" x="20" y="20"/>',
      '<rect x="1" y="1" width="5" height="5" fill="red"/>',
      '</svg>',
    ].join('');
    const parsed = parseSvgGeometries(hiddenSymbolTwice);
    expect(parsed.elements).toHaveLength(1);

    const cyclic = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">',
      '<g id="a"><use href="#b"/></g>',
      '<g id="b"><use href="#a"/></g>',
      '<use href="#a"/>',
      '</svg>',
    ].join('');
    let cycleErr: unknown;
    try {
      parseSvgGeometries(cyclic);
    } catch (err) {
      cycleErr = err;
    }
    expect(cycleErr).toBeInstanceOf(CadGeometryUnavailableError);
    expect((cycleErr as Error).message).toMatch(/cycle/);

    for (const ref of ['&#0;', '&#x0;', '&#55296;', '&#xD800;', '&#xFFFF;']) {
      let xmlErr: unknown;
      try {
        parseSvgGeometries(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="${ref}" width="5" height="5"/></svg>`);
      } catch (err) {
        xmlErr = err;
      }
      expect(xmlErr).toBeInstanceOf(CadGeometryUnavailableError);
      expect((xmlErr as Error).message).toMatch(/Invalid XML character reference/);
    }
  });
});

describe('deep-review hardening: API job input validation, JSON field bounds, and error redaction', () => {
  it('blocks spoofed stored uploads paired with valid decoy inline bytes in POST /api/v1/jobs and POST /api/queue/jobs', async () => {
    const { user, apiKey } = await makeTestUserWithKey('paid');
    const validPdf = await PDFDocument.create();
    validPdf.addPage([50, 50]);
    const validPdfBytes = Buffer.from(await validPdf.save());
    const spoofedPdfKey = await storeUserUpload(user.id, 'decoy.pdf', Buffer.from('Plain text pretending to be PDF\n'), 'application/pdf');

    const v1Res = await v1JobsPost(
      new NextRequest(`${BASE_URL}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          filename: 'decoy.pdf',
          targetFormat: 'txt',
          storageKey: spoofedPdfKey,
          inputBufferBase64: validPdfBytes.toString('base64'),
        }),
      })
    );
    expect(v1Res.status).toBe(400);
    const v1Body = (await v1Res.json()) as { code?: string; title?: string };
    expect(v1Body.code).toBe('spoofed_file');
    expect(v1Body.title).toBe('File Spoofing Detected');

    const queueRes = await queueJobsPost(
      new NextRequest(`${BASE_URL}/api/queue/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          filename: 'decoy.pdf',
          targetFormat: 'txt',
          storageKey: spoofedPdfKey,
          inputBufferBase64: validPdfBytes.toString('base64'),
        }),
      })
    );
    expect(queueRes.status).toBe(400);
    const queueBody = (await queueRes.json()) as { code?: string };
    expect(queueBody.code).toBe('spoofed_file');
  });

  it('rejects multipart options fields containing >65,536 JSON openers with 413 before parsing', async () => {
    const { apiKey } = await makeTestUserWithKey('paid');
    const tinyPng = await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    const floodedOptions = `{"rows":[${'{},'.repeat(70_000)}{}]}`;

    const formV1 = new FormData();
    formV1.set('file', new File([new Uint8Array(tinyPng)], 'dot.png', { type: 'image/png' }));
    formV1.set('targetFormat', 'webp');
    formV1.set('options', floodedOptions);
    const resV1 = await v1ConvertPost(
      new NextRequest(`${BASE_URL}/api/v1/convert`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: formV1,
      })
    );
    expect(resV1.status).toBe(413);
    expect(((await resV1.json()) as { detail?: string }).detail).toContain('65536');

    const formWeb = new FormData();
    formWeb.set('file', new File([new Uint8Array(tinyPng)], 'dot.png', { type: 'image/png' }));
    formWeb.set('targetFormat', 'webp');
    formWeb.set('options', floodedOptions);
    const resWeb = await convertPost(
      new NextRequest(`${BASE_URL}/api/convert`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: formWeb,
      })
    );
    expect(resWeb.status).toBe(413);
  });

  it('enforces spoof check and concurrency limit on POST /api/tools/jobs without reserving quota', async () => {
    const { user, apiKey } = await makeTestUserWithKey('free');
    const badPdfKey = await storeUserUpload(user.id, 'bad.pdf', Buffer.from('Not really a PDF document\n'), 'application/pdf');
    const pdfA = await PDFDocument.create();
    pdfA.addPage([100, 100]);
    const validPdfBytes = Buffer.from(await pdfA.save());
    const goodPdfKey1 = await storeUserUpload(user.id, 'a.pdf', validPdfBytes, 'application/pdf');
    const goodPdfKey2 = await storeUserUpload(user.id, 'b.pdf', validPdfBytes, 'application/pdf');

    const spoofRes = await toolJobsPost(
      new NextRequest(`${BASE_URL}/api/tools/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          tool: 'rotate',
          files: [{ key: badPdfKey, name: 'bad.pdf' }],
        }),
      })
    );
    expect(spoofRes.status).toBe(400);
    expect(((await spoofRes.json()) as { code?: string }).code).toBe('spoofed_file');

    vi.stubEnv('CONVERSION_CONCURRENCY_FREE', '1');
    const heldSlot = await acquireSyncSlot(user.id, 'free');
    expect(heldSlot.granted).toBe(true);
    if (!heldSlot.granted) throw new Error('expected heldSlot to be granted');
    try {
      const limitRes = await toolJobsPost(
        new NextRequest(`${BASE_URL}/api/tools/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            tool: 'merge',
            files: [
              { key: goodPdfKey1, name: 'a.pdf' },
              { key: goodPdfKey2, name: 'b.pdf' },
            ],
          }),
        })
      );
      expect(limitRes.status).toBe(429);
      const body = (await limitRes.json()) as { title?: string; status?: number };
      expect(body.status).toBe(429);
    } finally {
      heldSlot.release();
    }
  });

  it('rejects null JSON bodies on credentials and direct upload routes, and validates direct partSize/mimeType', async () => {
    const { apiKey } = await makeTestUserWithKey('paid');

    const credNull = await credentialsPost(
      new NextRequest(`${BASE_URL}/api/v1/storage/credentials`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: 'null',
      })
    );
    expect(credNull.status).toBe(400);
    expect(((await credNull.json()) as { detail?: string }).detail).toContain('JSON object');

    const directNull = await directUploadPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: 'null',
      })
    );
    expect(directNull.status).toBe(400);

    const directBadPart = await directUploadPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ filename: 'test.png', mimeType: 'image/png', totalSize: 1024, partSize: 1.5 }),
      })
    );
    expect(directBadPart.status).toBe(400);
    expect(((await directBadPart.json()) as { detail?: string }).detail).toContain('partSize');

    const directBadMime = await directUploadPost(
      new NextRequest(`${BASE_URL}/api/v1/uploads/direct`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ filename: 'test.png', mimeType: 42, totalSize: 1024 }),
      })
    );
    expect(directBadMime.status).toBe(400);
    expect(((await directBadMime.json()) as { detail?: string }).detail).toContain('mimeType');
  });

  it('promotes package-credit holders to paid tier directly in POST /api/auth/login response', async () => {
    const email = `credits_login_${crypto.randomBytes(6).toString('hex')}@hardening.test`;
    const password = 'ValidLoginPass123!';
    const { hash, salt, iterations } = await hashPassword(password);
    const created = await redisUserStore.createUser({
      email,
      name: 'Credit User',
      tier: 'free',
      emailVerified: true,
      passwordHash: hash,
      salt,
      passwordIterations: iterations,
    });
    await redisKeyStore.creditPackage(created.id, {
      transactionId: `txn_${crypto.randomBytes(6).toString('hex')}`,
      credits: 25,
      paid: '500',
      at: Date.now(),
    });

    const loginRes = await loginPost(
      new NextRequest(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
    );
    expect(loginRes.status).toBe(200);
    const body = (await loginRes.json()) as { success: boolean; user?: { id: string; tier: string } };
    expect(body.success).toBe(true);
    expect(body.user?.tier).toBe('paid');
  });
});

describe('deep-review hardening: streaming idempotency and stale /tmp scratch sweep', () => {
  it('omits >256 KiB binary idempotency bodies while recording Content-Length without reading stream', async () => {
    const store = new InMemoryIdempotencyStore();
    let pulled = 0;
    const bodyStream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    const oversizedBytes = IDEMPOTENCY_MAX_STORED_BODY_BYTES + 1024;
    const response = new NextResponse(bodyStream, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(oversizedBytes),
      },
    });
    const scopedKey = `idem:test:${crypto.randomBytes(6).toString('hex')}`;
    await store.acquire(scopedKey, 'fp', 60_000, 'tok');
    await storeCompletedResponse(store, scopedKey, 'fp', response, 'tok');
    const saved = await store.getRecord(scopedKey);
    expect(pulled).toBe(0);
    expect(response.bodyUsed).toBe(false);
    expect(response.body?.locked).toBe(false);
    expect(saved?.response?.body).toBe('');
    expect(saved?.response?.omittedBodyBytes).toBe(oversizedBytes);
  });

  it('sweeps aged tool scratch directories left in tmpdir without deleting active ones', () => {
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-probe-'));
    tempDirs.push(sandboxRoot);
    const agedQpdf = path.join(sandboxRoot, 'easyconvert-qpdf_stale01');
    const agedAvif = path.join(sandboxRoot, 'easyconvert-avif-stale01');
    const agedDecode = path.join(sandboxRoot, 'easyconvert-decode-stale01');
    const freshQpdf = path.join(sandboxRoot, 'easyconvert-qpdf_fresh01');
    const unrelated = path.join(sandboxRoot, 'other-app-tmp');
    fs.mkdirSync(agedQpdf);
    fs.mkdirSync(agedAvif);
    fs.mkdirSync(agedDecode);
    fs.mkdirSync(freshQpdf);
    fs.mkdirSync(unrelated);

    const now = Date.now();
    const expiredSec = (now - JOB_STAGING_MAX_AGE_MS - 60_000) / 1000;
    fs.utimesSync(agedQpdf, expiredSec, expiredSec);
    fs.utimesSync(agedAvif, expiredSec, expiredSec);
    fs.utimesSync(agedDecode, expiredSec, expiredSec);

    const removed = sweepWorkerSandboxDirs({ directory: sandboxRoot, now });
    expect(removed).toContain('easyconvert-qpdf_stale01');
    expect(removed).toContain('easyconvert-avif-stale01');
    expect(removed).toContain('easyconvert-decode-stale01');
    expect(removed).not.toContain('easyconvert-qpdf_fresh01');
    expect(removed).not.toContain('other-app-tmp');
    expect(fs.existsSync(agedQpdf)).toBe(false);
    expect(fs.existsSync(agedAvif)).toBe(false);
    expect(fs.existsSync(agedDecode)).toBe(false);
    expect(fs.existsSync(freshQpdf)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
