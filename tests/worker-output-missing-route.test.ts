import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import JSZip from 'jszip';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { WORKER_OUTPUT_MISSING_DETAIL } from '../src/lib/types';

/**
 * Issue #484 at the HTTP boundary: when the worker's persisted output vanished before the route read it, the
 * synchronous convert endpoint answers 500 (a server fault, not a 400 verdict on the input), never a 0-byte
 * 200, and does not name the worker's file in the response.
 *
 * The dispatcher is replaced by one that returns a real worker result whose file was deleted afterwards; the
 * route under test and the result type are the production ones.
 */

const HTTP_INTERNAL_SERVER_ERROR = 500;
const WORKER_FILE_NAME = 'easyconvert-out-vanished-0001.tar';

const dispatchState = vi.hoisted(() => ({ outputDir: '' }));

vi.mock('../src/lib/conversions/dispatch', async () => {
  const fsModule = await import('node:fs');
  const pathModule = await import('node:path');
  const engines = await import('../src/worker/engines');
  return {
    dispatchConversion: async () => {
      const outputPath = pathModule.join(dispatchState.outputDir, WORKER_FILE_NAME);
      fsModule.writeFileSync(outputPath, 'tar bytes that are about to vanish');
      const result = engines.createConversionResult(outputPath, 'tar', 'bundle', 'native-7z', 1);
      fsModule.rmSync(outputPath);
      return result;
    },
  };
});

const { POST: v1ConvertPost } = await import('../src/app/api/v1/convert/route');

let secretKey: string;

beforeEach(async () => {
  dispatchState.outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-output-route-'));
  const user = await userStore.createUser({
    name: 'Output Missing Tester',
    email: `output_missing_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  secretKey = (await redisKeyStore.generateApiKey(user.id, 'Output Missing Key', { scopes: ['convert:write'] })).secretKey;
});

afterEach(() => {
  fs.rmSync(dispatchState.outputDir, { recursive: true, force: true });
});

describe('POST /api/v1/convert with a vanished worker output', () => {
  it('answers 500 with a generic detail and stores nothing', async () => {
    const zip = new JSZip();
    zip.file('hello.txt', 'hello');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))]), 'bundle.zip');
    form.append('targetFormat', 'tar');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await v1ConvertPost(
      new NextRequest('http://localhost:3000/api/v1/convert', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}` },
        body: form,
      })
    );

    expect(res.status).toBe(HTTP_INTERNAL_SERVER_ERROR);
    const problem = await res.json();
    expect(problem.detail).toBe(WORKER_OUTPUT_MISSING_DETAIL);
    expect(JSON.stringify(problem)).not.toContain(WORKER_FILE_NAME);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});
