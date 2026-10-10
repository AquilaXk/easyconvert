import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { POST as convertPost } from '../src/app/api/convert/route';
import { POST as batchPost } from '../src/app/api/convert/batch/route';
import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { ArchivePasswordRequiredError, InvalidArchivePasswordError, UnsupportedArchiveMethodError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { buildStoredRar4 } from './helpers/rar4-stored';

/**
 * A password-protected archive is intact: the service lacks (or was given the wrong) key. The convert routes, the
 * batch route and the failed job answer 422 for 7z, ZIP and RAR alike, like the password errors of a PDF, where a
 * malformed archive answers 400. Archives are written by the `7z` CLI (and a byte-level RAR writer verified by
 * `unrar`) and converted by the production routes.
 */
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNPROCESSABLE = 422;
const BASE_URL = 'http://localhost:3000';
const COMMAND_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;
const PASSWORD = 'Correct-Horse-Battery-1';
const WRONG_PASSWORD = 'not-the-password';
const PAYLOAD = Buffer.from('confidential notes for the password route tests\n'.repeat(40));
const RAR_FILES = [{ name: 'secret.txt', data: PAYLOAD }];

let workDir = '';

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-password-routes-'));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function sevenZipArchive(label: string, type: '7z' | 'zip', extra: string[]): Buffer {
  const dir = path.join(workDir, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'secret.txt'), PAYLOAD);
  const archive = path.join(dir, `fixture.${type}`);
  execFileSync(requireOracleTool('7z'), ['a', '-y', `-t${type}`, ...extra, archive, 'secret.txt'], { cwd: dir, timeout: COMMAND_TIMEOUT_MS, stdio: 'pipe' });
  return fs.readFileSync(archive);
}

function form(archive: Buffer, name: string, target: string, password?: string, fieldName = 'file'): FormData {
  const data = new FormData();
  data.append(fieldName, new Blob([new Uint8Array(archive)]), name);
  data.append('targetFormat', target);
  if (password !== undefined) data.append('options', JSON.stringify({ password }));
  return data;
}

async function apiKeyHeaders(): Promise<Record<string, string>> {
  const user = await userStore.createUser({
    name: 'Archive Password Route Tester',
    email: `archive_password_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'Archive password key', { scopes: ['convert:write', 'convert:read'] });
  return { Authorization: `Bearer ${key.secretKey}` };
}

async function convertStatus(archive: Buffer, name: string, password?: string, target = 'zip'): Promise<{ status: number; detail: string }> {
  const res = await convertPost(new NextRequest(`${BASE_URL}/api/convert`, { method: 'POST', body: form(archive, name, target, password) }));
  if (res.status === HTTP_OK) return { status: res.status, detail: '' };
  const body = await res.json();
  return { status: res.status, detail: String(body.detail ?? body.error) };
}

describe('a password-protected archive answers 422 on POST /api/convert', () => {
  for (const headerMode of ['-mhe=off', '-mhe=on']) {
    oracleTest(
      `7z (${headerMode}): no password and a wrong password are 422, the right one converts`,
      ['7z'],
      async () => {
        const archive = sevenZipArchive(`seven-${headerMode}`, '7z', [`-p${PASSWORD}`, headerMode, '-mf=BCJ']);
        const missing = await convertStatus(archive, 'secret.7z');
        expect(missing.status).toBe(HTTP_UNPROCESSABLE);
        expect(missing.detail).toMatch(/password protected\. A password is required/);
        const wrong = await convertStatus(archive, 'secret.7z', WRONG_PASSWORD);
        expect(wrong.status).toBe(HTTP_UNPROCESSABLE);
        expect(wrong.detail).toMatch(/Invalid password/);
        expect(wrong.detail).not.toContain(WRONG_PASSWORD);
        expect((await convertStatus(archive, 'secret.7z', PASSWORD)).status).toBe(HTTP_OK);
      },
      TEST_TIMEOUT_MS
    );
  }

  oracleTest(
    'ZIP: no password and a wrong password are 422, the right one converts',
    ['7z'],
    async () => {
      const archive = sevenZipArchive('zip', 'zip', [`-p${PASSWORD}`, '-mem=AES256']);
      const missing = await convertStatus(archive, 'secret.zip', undefined, '7z');
      expect(missing.status).toBe(HTTP_UNPROCESSABLE);
      expect(missing.detail).toMatch(/password protected\. A password is required/);
      const wrong = await convertStatus(archive, 'secret.zip', WRONG_PASSWORD, '7z');
      expect(wrong.status).toBe(HTTP_UNPROCESSABLE);
      expect(wrong.detail).toMatch(/Invalid password/);
      expect((await convertStatus(archive, 'secret.zip', PASSWORD, '7z')).status).toBe(HTTP_OK);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'RAR: no password and a wrong password are 422, the right one converts',
    ['unrar'],
    async () => {
      const archive = buildStoredRar4(RAR_FILES, { password: PASSWORD });
      const missing = await convertStatus(archive, 'secret.rar');
      expect(missing.status).toBe(HTTP_UNPROCESSABLE);
      expect(missing.detail).toMatch(/password protected\. A password is required/);
      const wrong = await convertStatus(archive, 'secret.rar', WRONG_PASSWORD);
      expect(wrong.status).toBe(HTTP_UNPROCESSABLE);
      expect(wrong.detail).toMatch(/Invalid password/);
      expect((await convertStatus(archive, 'secret.rar', PASSWORD)).status).toBe(HTTP_OK);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'a damaged 7z is still 400',
    ['7z'],
    async () => {
      const damaged = Buffer.from(sevenZipArchive('damaged', '7z', []));
      damaged[8] ^= 0xff;
      expect((await convertStatus(damaged, 'damaged.7z')).status).toBe(HTTP_BAD_REQUEST);
    },
    TEST_TIMEOUT_MS
  );
});

describe('the other convert routes answer the same 422', () => {
  oracleTest(
    'POST /api/v1/convert answers a 422 problem document for a 7z without its password',
    ['7z'],
    async () => {
      const archive = sevenZipArchive('v1', '7z', [`-p${PASSWORD}`, '-mhe=on']);
      const headers = await apiKeyHeaders();
      const res = await v1ConvertPost(new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(archive, 'secret.7z', 'zip') }));
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const problem = await res.json();
      expect(problem).toMatchObject({ status: HTTP_UNPROCESSABLE, title: 'Unprocessable Entity' });
      expect(problem.detail).toMatch(/password protected\. A password is required/);

      const wrong = await v1ConvertPost(
        new NextRequest(`${BASE_URL}/api/v1/convert`, { method: 'POST', headers, body: form(archive, 'secret.7z', 'zip', WRONG_PASSWORD) })
      );
      expect(wrong.status).toBe(HTTP_UNPROCESSABLE);
      expect((await wrong.json()).detail).toMatch(/Invalid password/);
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'POST /api/convert/batch answers 422 for a 7z without its password',
    ['7z'],
    async () => {
      const archive = sevenZipArchive('batch', '7z', [`-p${PASSWORD}`]);
      const body = form(archive, 'secret.7z', 'zip', undefined, 'files');
      body.append('targetFormats', JSON.stringify({ default: 'zip' }));
      const res = await batchPost(new NextRequest(`${BASE_URL}/api/convert/batch`, { method: 'POST', body }));
      expect(res.status).toBe(HTTP_UNPROCESSABLE);
      expect((await res.json()).detail).toMatch(/password protected\. A password is required/);
    },
    TEST_TIMEOUT_MS
  );
});

describe('archive input errors fail a job once, with status 422', () => {
  it.each([
    ['ArchivePasswordRequiredError', new ArchivePasswordRequiredError('locked')],
    ['InvalidArchivePasswordError', new InvalidArchivePasswordError('wrong')],
    ['UnsupportedArchiveMethodError', new UnsupportedArchiveMethodError('method')],
  ])('%s is a non-retryable 422', (code, error) => {
    expect(classifyJobFailure(error)).toEqual({ code, status: HTTP_UNPROCESSABLE, retryable: false });
  });
});
