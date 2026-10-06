import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { redisKeyStore } from '../../src/lib/api-keys/redis-key-store';
import { userStore } from '../../src/lib/auth/user-store';
import { POST as v1ConvertPost } from '../../src/app/api/v1/convert/route';
import { POST as legacyConvertPost } from '../../src/app/api/convert/route';
import { POST as batchConvertPost } from '../../src/app/api/convert/batch/route';

/**
 * Drives the three synchronous convert routes with a PDF/A request, with a validator that is a
 * small executable script. The script stands in for veraPDF's output only; the conversion, the
 * routes and the error mapping are the real ones.
 */

export const HTTP_UNPROCESSABLE = 422;
export const HTTP_SERVICE_UNAVAILABLE = 503;

/** Report veraPDF prints for a file that violates two rules of ISO 19005-2. */
export const NON_COMPLIANT_REPORT =
  '{"report":{"jobs":[{"validationResult":[{"compliant":false,"profileName":"PDF/A-2B validation profile",' +
  '"details":{"ruleSummaries":[' +
  '{"specification":"ISO 19005-2:2011","clause":"6.2.11.4.1","testNumber":1,"status":"failed"},' +
  '{"specification":"ISO 19005-2:2011","clause":"6.1.3","testNumber":1,"status":"failed"}]}}]}]}}';
export const NON_COMPLIANT_RULES = ['6.2.11.4.1-1', '6.1.3-1'];

/** Report veraPDF prints when it cannot parse the file: a task exception and no validation result. */
export const TASK_EXCEPTION_REPORT =
  '{"report":{"jobs":[{"itemDetails":{"name":"/tmp/secret-work-dir/candidate.pdf","size":7},' +
  '"taskException":{"exception":"Couldn\'t parse stream","type":"PARSE","success":false,' +
  '"exceptionMessage":"Exception: Couldn\'t parse stream caused by exception: End of file is reached"}}]}}';

export interface ValidatorScripts {
  dir: string;
  /** Writes an executable script that runs `body` and returns its path. */
  write(name: string, body: string): string;
  /** A validator that prints `stdout` and exits with `exitCode`. */
  printing(name: string, stdout: string, exitCode: number): string;
  dispose(): void;
}

export function createValidatorScripts(): ValidatorScripts {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfa-validators-'));
  const write = (name: string, body: string): string => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  return {
    dir,
    write,
    printing: (name, stdout, exitCode) => {
      const reportFile = path.join(dir, `${name}.json`);
      fs.writeFileSync(reportFile, stdout);
      return write(name, `cat "${reportFile}"\nexit ${exitCode}`);
    },
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs `operation` with VERAPDF_PATH set to `validator`, then restores the variable. */
export async function withValidator<T>(validator: string, operation: () => Promise<T>): Promise<T> {
  const previous = process.env.VERAPDF_PATH;
  process.env.VERAPDF_PATH = validator;
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env.VERAPDF_PATH;
    else process.env.VERAPDF_PATH = previous;
  }
}

export async function createApiKey(): Promise<string> {
  const user = await userStore.createUser({
    name: 'PDF/A Route Tester',
    email: `pdfa_route_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
    tier: 'pro',
  });
  const key = await redisKeyStore.generateApiKey(user.id, 'PDF/A Route Key', { scopes: ['convert:write', 'convert:read'] });
  return key.secretKey;
}

export interface RouteCall {
  name: string;
  call(file: Buffer, fileName: string, targetFormat: string, options: object): Promise<Response>;
}

/** The three synchronous convert routes, each behind the same call signature. */
export function convertRoutes(secretKey: string): RouteCall[] {
  const blob = (file: Buffer) => new Blob([new Uint8Array(file)]);
  return [
    {
      name: 'POST /api/v1/convert',
      call: (file, fileName, targetFormat, options) => {
        const form = new FormData();
        form.append('file', blob(file), fileName);
        form.append('targetFormat', targetFormat);
        form.append('options', JSON.stringify(options));
        return v1ConvertPost(
          new NextRequest('http://localhost/api/v1/convert', {
            method: 'POST',
            headers: { Authorization: `Bearer ${secretKey}` },
            body: form,
          })
        );
      },
    },
    {
      name: 'POST /api/convert',
      call: (file, fileName, targetFormat, options) => {
        const form = new FormData();
        form.append('file', blob(file), fileName);
        form.append('targetFormat', targetFormat);
        form.append('options', JSON.stringify(options));
        return legacyConvertPost(new NextRequest('http://localhost/api/convert', { method: 'POST', body: form }));
      },
    },
    {
      name: 'POST /api/convert/batch',
      call: (file, fileName, targetFormat, options) => {
        const form = new FormData();
        form.append('files', blob(file), fileName);
        form.append('targetFormats', JSON.stringify({ default: targetFormat }));
        form.append('options', JSON.stringify(options));
        return batchConvertPost(new NextRequest('http://localhost/api/convert/batch', { method: 'POST', body: form }));
      },
    },
  ];
}
