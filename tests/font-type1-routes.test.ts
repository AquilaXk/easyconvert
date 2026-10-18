import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { isFormatCompatibleWithMagicBytes } from '../src/lib/registry';
import { EngineUnavailableError, UnprocessableFontInputError } from '../src/lib/types';
import { buildPfa, buildPfb, pfaWithGarbageRun, rectangleGlyph } from './helpers/type1-builder';

/**
 * What the three convert routes and a failed job answer for a Type 1 font: 400 for bytes that are no Type 1 container, 422 with the reason
 * for a container with no usable font in it, 503 when FontForge is missing. The inputs are refused by the reader before any program
 * starts, or fail at the program lookup, so these tests need no FontForge.
 */

const BASE_URL = 'http://localhost:3000';
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;
const NOT_A_FONT = Buffer.from('%!PS-Adobe-3.0\n/Helvetica findfont 12 scalefont setfont\nshowpage\n');
const GLYPHS = [rectangleGlyph('.notdef', 500, 50, 400, 700), rectangleGlyph('A', 600, 40, 300, 650)];
const USABLE_FONT = buildPfa(GLYPHS);

function form(file: Buffer, name: string, fieldName = 'file'): FormData {
  const data = new FormData();
  data.append(fieldName, new Blob([new Uint8Array(file)]), name);
  data.append('targetFormat', 'otf');
  return data;
}

async function apiKeyHeaders(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Type1 Route Tester',
    email: `type1_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Type1 key', { scopes: ['convert:write', 'convert:read'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

const missingProgram = process.env.FONTFORGE_PATH;
afterEach(() => {
  if (missingProgram === undefined) delete process.env.FONTFORGE_PATH;
  else process.env.FONTFORGE_PATH = missingProgram;
});

describe('the upload check lets the Type 1 headers through', () => {
  it.each([
    ['PFA', '%!PS-AdobeFont-1.0', 'pfa'],
    ['PFA', '%!FontType1-1.0', 'pfa'],
    ['PFB', '%!PS-AdobeFont-1.0', 'pfb'],
  ] as const)('accepts a %s whose first line is %s', (_label, signature, extension) => {
    const file = extension === 'pfa' ? buildPfa(GLYPHS, { signature }) : buildPfb(GLYPHS, { signature });
    expect(isFormatCompatibleWithMagicBytes(file, extension)).toBe(true);
  });

  it('still refuses a Type 1 header under the name of another format', () => {
    expect(isFormatCompatibleWithMagicBytes(buildPfa(GLYPHS, { signature: '%!PS-AdobeFont-1.0' }), 'png')).toBe(false);
  });

  it('POST /api/convert reads a PFA that opens with %!PS-AdobeFont as a font: the program lookup fails, the upload check does not', async () => {
    process.env.FONTFORGE_PATH = '/nonexistent/fontforge';
    const file = buildPfa(GLYPHS, { signature: '%!PS-AdobeFont-1.0' });
    const res = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(file, 'adobe.pfa') }));
    expect(res.status).toBe(HTTP_UNAVAILABLE);
  });
});

describe('a Type 1 font answers a typed status on every convert route', () => {
  it('POST /api/convert answers 400 for a file that is no Type 1 font and 422 for a font with nothing in it', async () => {
    const text = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(NOT_A_FONT, 'page.pfa') }));
    expect(text.status).toBe(HTTP_BAD_REQUEST);
    expect((await text.json()).error).toMatch(/starts with neither/);

    const hollow = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(pfaWithGarbageRun(), 'hollow.pfa') }));
    expect(hollow.status).toBe(HTTP_UNPROCESSABLE);
    expect((await hollow.json()).title).toBe('Unprocessable Entity');
  });

  it('POST /api/convert answers 503 when FontForge is not installed', async () => {
    process.env.FONTFORGE_PATH = '/nonexistent/fontforge';
    const res = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(USABLE_FONT, 'face.pfa') }));
    expect(res.status).toBe(HTTP_UNAVAILABLE);
  });

  it('POST /api/v1/convert answers a 422 problem document', async () => {
    const headers = await apiKeyHeaders();
    const res = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(pfaWithGarbageRun(), 'hollow.pfa') }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ status: HTTP_UNPROCESSABLE, title: 'Unprocessable Entity' });
  });

  it('POST /api/convert/batch answers 422', async () => {
    const body = form(pfaWithGarbageRun(), 'hollow.pfa', 'files');
    body.append('targetFormats', JSON.stringify({ default: 'otf' }));
    const res = await batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', body }));
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
  });

  it('fails a queued job once, as a non-retryable 422, and retries a missing program on another worker', () => {
    expect(classifyJobFailure(new UnprocessableFontInputError('FontForge read 1 of the 4 glyphs'))).toEqual({
      code: 'UnprocessableFontInputError',
      status: HTTP_UNPROCESSABLE,
      retryable: false,
    });
    expect(classifyJobFailure(new EngineUnavailableError('fontforge'))).toMatchObject({ status: HTTP_UNAVAILABLE, retryable: true });
  });
});
