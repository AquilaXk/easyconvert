import { execFileSync } from 'node:child_process';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { GET } from '../src/app/api/v1/ocr/languages/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { ConversionOptionsSchema, OcrLanguagesResponseSchema } from '../src/lib/api/contracts';
import { ajv, validateOrProblem } from '../src/lib/api/contracts/validate';
import { userStore } from '../src/lib/auth/user-store';
import { resetInstalledTraineddata } from '../src/lib/conversions/ocr-language-data';
import { oracleTest } from './helpers/oracle-test';
import { requireTesseract } from './helpers/ocr-fixtures';

/**
 * GET /api/v1/ocr/languages and the `ocrLanguage` contract. The installed set the route reports is compared with
 * `tesseract --list-langs`, and the body is checked against the schema of the served OpenAPI document, not the
 * route's own types.
 */

const URL_OF_ROUTE = 'http://localhost/api/v1/ocr/languages';
const REFERENCE_TIMEOUT_MS = 30_000;
const SHORT_CACHE_SECONDS = 300;

interface LanguageRow {
  code: string;
  traineddata: string;
  name: string;
  script: string;
  direction: string;
  installed: boolean;
}

let readKey: string;
let usageOnlyKey: string;

beforeEach(async () => {
  userStore.resetStore();
  redisKeyStore.resetStore();
  resetInstalledTraineddata();
  const user = await userStore.createUser({ email: 'ocr-languages@example.com', name: 'OCR Languages' });
  ({ secretKey: readKey } = await redisKeyStore.generateApiKey(user.id, 'Reader', { scopes: ['convert:read'] }));
  ({ secretKey: usageOnlyKey } = await redisKeyStore.generateApiKey(user.id, 'Usage only', { scopes: ['read:usage'] }));
});

const request = (key?: string): NextRequest =>
  new NextRequest(URL_OF_ROUTE, { method: 'GET', headers: key ? { 'x-api-key': key } : {} });

describe('GET /api/v1/ocr/languages', () => {
  it('answers 401 without a key and 403 to a key without the convert:read scope', async () => {
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request(usageOnlyKey))).status).toBe(403);
  });

  it('lists the languages with a short private cache', async () => {
    const response = await GET(request(readKey));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(`private, max-age=${SHORT_CACHE_SECONDS}`);
    const body = (await response.json()) as { success: true; languages: LanguageRow[]; maxLanguagesPerRequest: number };
    expect(body.success).toBe(true);
    expect(body.maxLanguagesPerRequest).toBe(4);
    expect(body.languages.length).toBeGreaterThanOrEqual(100);
    const codes = body.languages.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    const byName = new Map(body.languages.map((row) => [row.traineddata, row]));
    expect(byName.get('ara')).toMatchObject({ code: 'ar', script: 'Arab', direction: 'rtl' });
    expect(byName.get('rus')).toMatchObject({ code: 'ru', script: 'Cyrl', direction: 'ltr' });
    expect(byName.get('hin')).toMatchObject({ code: 'hi', script: 'Deva' });
    expect(byName.get('jpn_vert')).toMatchObject({ code: 'jpn_vert', direction: 'ttb' });
  });

  it('answers with a body the served OpenAPI document describes', async () => {
    const spec = (await (await getOpenApiSpec()).json()) as {
      paths: Record<string, { get?: { operationId: string; security: unknown[]; responses: Record<string, unknown> } }>;
      components: { schemas: Record<string, unknown> };
    };
    const operation = spec.paths['/api/v1/ocr/languages']?.get;
    expect(operation?.operationId).toBe('listOcrLanguagesV1');
    expect(operation?.security).toEqual([{ ApiKeyAuth: ['convert:read'] }, { BearerAuth: ['convert:read'] }]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(expect.arrayContaining(['200', '401', '403']));
    expect(spec.components.schemas.OcrLanguagesResponse).toBeDefined();
    expect(spec.components.schemas.OcrLanguageEntry).toBeDefined();
    const body = await (await GET(request(readKey))).json();
    const checked = validateOrProblem(OcrLanguagesResponseSchema, body);
    expect(checked.ok).toBe(true);
    expect(ajv.getSchema(OcrLanguagesResponseSchema.$id)).toBeDefined();
  });

  oracleTest(
    'reports a language installed exactly when the tesseract command line lists it, and eng and kor are installed',
    ['tesseract'],
    async () => {
      const listing = execFileSync(requireTesseract(), ['--list-langs'], { encoding: 'utf-8', timeout: REFERENCE_TIMEOUT_MS });
      const listed = new Set(
        listing
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean)
      );
      const body = (await (await GET(request(readKey))).json()) as { languages: LanguageRow[] };
      for (const row of body.languages) expect(row.installed, row.traineddata).toBe(listed.has(row.traineddata));
      const installedNames = body.languages.filter((row) => row.installed).map((row) => row.traineddata);
      expect(installedNames).toEqual(expect.arrayContaining(['eng', 'kor']));
    }
  );
});

describe('the ocrLanguage option contract', () => {
  const check = (ocrLanguage: unknown) => validateOrProblem(ConversionOptionsSchema, { ocrLanguage });

  it('accepts a language by traineddata name, ISO code or BCP 47 tag, and up to four joined with +', () => {
    for (const value of ['auto', 'en', 'ko', 'ara', 'zh-Hans', 'sr-Latn', 'eng+kor', 'ara+rus+hin+jpn', 'chi_sim_vert']) {
      expect(check(value).ok, value).toBe(true);
    }
  });

  it('rejects five languages, an empty part, and text that is not a language code', () => {
    for (const value of ['eng+kor+jpn+deu+fra', 'eng+', '+eng', 'eng kor', 'eng;rm -rf', '../eng', '', 'a'.repeat(200), 7]) {
      expect(check(value).ok, String(value)).toBe(false);
    }
  });
});
