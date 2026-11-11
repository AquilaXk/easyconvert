import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Whether the simulated host denies `unshare` its namespaces, the way Docker's default seccomp profile does without
 * CAP_SYS_ADMIN. Only the capability probe's own `unshare` call fails; every other child process runs for real.
 */
const host = vi.hoisted(() => ({ denyUnshare: false }));
const UNSHARE_EPERM_STATUS = 1;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (host.denyUnshare && file.endsWith('/unshare')) {
      throw Object.assign(new Error('unshare: unshare failed: Operation not permitted'), { status: UNSHARE_EPERM_STATUS });
    }
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import { POST as v1ConvertPost } from '../src/app/api/v1/convert/route';
import { POST as convertPost } from '../src/app/api/convert/route';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import {
  executeSandboxedBinary,
  getUnshareCapability,
  resetUnshareCapabilityCache,
  SandboxedProcessError,
} from '../src/lib/security/process-sandbox';
import { convertWithNative7z } from '../src/lib/conversions/archive';
import { recognizeWithCli } from '../src/lib/conversions/ocr-cli';
import { classifyJobFailure, isFinalFailure } from '../src/lib/queue/job-failure';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';
import { EngineUnavailableError, SandboxUnavailableError } from '../src/lib/types';
import { skipUnless } from './helpers/strict-skip';

const HTTP_SERVICE_UNAVAILABLE = 503;
const ENGINE_UNAVAILABLE_TYPE = 'https://api.easyconvert.io/problems/engine-unavailable';
const CONVERT_TIMEOUT_MS = 120_000;
const SAMPLE_PDF = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.pdf'));
const SAMPLE_DOCX = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const SAMPLE_ZIP = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.zip'));
const SAMPLE_PNG = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.png'));
const QUEUE_ATTEMPTS = 3;
const SPY_MODE = 0o755;

/** Every environment variable the engines read to locate a native CLI. */
const TOOL_PATH_VARIABLES = [
  'SOFFICE_PATH', 'FFMPEG_PATH', 'FFPROBE_PATH', 'P7ZIP_PATH', 'P7Z_PATH', 'PDFINFO_PATH', 'PDFTOCAIRO_PATH',
  'PDFTOPPM_PATH', 'PDFTOPS_PATH', 'PDFTOTEXT_PATH', 'PS2PDF_PATH', 'TESSERACT_PATH', 'DCRAW_EMU_PATH',
  'UNRAR_PATH', 'ZIP_PATH',
] as const;

const HAS_NAMESPACES = getUnshareCapability().available;

let spyDir = '';
let spyLog = '';

/** The command lines the spy binaries recorded; empty when no native tool was ever started. */
function spawnedTools(): string[] {
  return existsSync(spyLog) ? readFileSync(spyLog, 'utf-8').split('\n').filter(Boolean) : [];
}

beforeAll(() => {
  spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-spy-'));
  spyLog = path.join(spyDir, 'invocations.log');
  for (const variable of TOOL_PATH_VARIABLES) {
    const spy = path.join(spyDir, variable.toLowerCase());
    writeFileSync(spy, `#!/bin/sh\necho "${variable} $*" >> "${spyLog}"\nexit 3\n`);
    chmodSync(spy, SPY_MODE);
  }
});

afterAll(() => {
  rmSync(spyDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(spyLog, { force: true });
  for (const variable of TOOL_PATH_VARIABLES) {
    vi.stubEnv(variable, path.join(spyDir, variable.toLowerCase()));
  }
  resetUnshareCapabilityCache();
});

afterEach(() => {
  host.denyUnshare = false;
  vi.unstubAllEnvs();
  resetUnshareCapabilityCache();
});

function forceSandboxUnavailable(): void {
  host.denyUnshare = true;
  vi.stubEnv('STRICT_SANDBOX', 'true');
  resetUnshareCapabilityCache();
}

describe.skipIf(skipUnless('a Linux host (network namespaces)', process.platform === 'linux'))('STRICT_SANDBOX with the namespace sandbox unavailable', () => {
  let secretKey: string;

  beforeEach(async () => {
    const user = await userStore.createUser({
      name: 'Sandbox 503 Tester',
      email: `sandbox503_${Date.now()}_${Math.random().toString(36).slice(2)}@easyconvert.local`,
      tier: 'pro',
    });
    const key = await redisKeyStore.generateApiKey(user.id, 'Sandbox 503 Key', { scopes: ['convert:write', 'convert:read'] });
    secretKey = key.secretKey;
  });

  function pdfToPngRequest(url: string): NextRequest {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(SAMPLE_PDF)]), 'sample.pdf');
    form.append('targetFormat', 'png');
    return new NextRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${secretKey}` }, body: form });
  }

  it(
    'answers 503 from /api/v1/convert for pdf to png and never starts a native tool',
    async () => {
      forceSandboxUnavailable();
      const res = await v1ConvertPost(pdfToPngRequest('http://localhost/api/v1/convert'));
      expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
      const problem = await res.json();
      expect(problem.type).toBe(ENGINE_UNAVAILABLE_TYPE);
      expect(JSON.stringify(problem)).not.toContain(os.tmpdir());
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it(
    'answers 503 from /api/convert for pdf to png and never starts a native tool',
    async () => {
      forceSandboxUnavailable();
      const res = await convertPost(pdfToPngRequest('http://localhost/api/convert'));
      expect(res.status).toBe(HTTP_SERVICE_UNAVAILABLE);
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it(
    'rejects the dispatcher with a SandboxUnavailableError instead of the in-process engine',
    async () => {
      forceSandboxUnavailable();
      const run = dispatchConversion(SAMPLE_PDF, 'pdf', 'png', {}, 'sample.pdf');
      await expect(run).rejects.toBeInstanceOf(SandboxUnavailableError);
      await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it(
    'also refuses a pair the in-process engine could serve, such as pdf to txt',
    async () => {
      forceSandboxUnavailable();
      await expect(dispatchConversion(SAMPLE_PDF, 'pdf', 'txt', {}, 'sample.pdf')).rejects.toBeInstanceOf(
        SandboxUnavailableError
      );
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it('throws before the spawn, with the tool, its arguments and the sandbox directory out of the message', async () => {
    forceSandboxUnavailable();
    const run = executeSandboxedBinary(process.env.PDFTOPPM_PATH!, ['-r', '72', '/secret/in.pdf'], { cwd: spyDir });
    await expect(run).rejects.toBeInstanceOf(SandboxUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName: 'sandbox' });
    const refusal = await run.then(
      () => null,
      (err: Error) => err
    );
    expect(refusal?.message).not.toMatch(/secret|pdftoppm/);
    expect(spawnedTools()).toEqual([]);
  });

  it(
    'refuses docx to pdf, which the in-process engine could also produce, instead of falling back',
    async () => {
      forceSandboxUnavailable();
      await expect(dispatchConversion(SAMPLE_DOCX, 'docx', 'pdf', {}, 'sample.docx')).rejects.toBeInstanceOf(
        SandboxUnavailableError
      );
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it(
    'refuses a zip to tar.gz repackaging that the in-process archive engine could also serve',
    async () => {
      forceSandboxUnavailable();
      await expect(dispatchConversion(SAMPLE_ZIP, 'zip', 'tar.gz', {}, 'sample.zip')).rejects.toBeInstanceOf(
        SandboxUnavailableError
      );
      expect(spawnedTools()).toEqual([]);
    },
    CONVERT_TIMEOUT_MS
  );

  it('does not hand the library 7-Zip hook to the in-process archive engines', () => {
    forceSandboxUnavailable();
    expect(() => convertWithNative7z(SAMPLE_ZIP, 'zip', 'tar.gz', {}, 'sample.zip')).toThrow(SandboxUnavailableError);
    expect(spawnedTools()).toEqual([]);
  });

  it('keeps the typed error through the native OCR runner instead of reporting a tool that did not start', async () => {
    forceSandboxUnavailable();
    const run = recognizeWithCli({
      cliPath: process.env.TESSERACT_PATH!,
      tessdataDir: spyDir,
      tesseractLang: 'eng',
      image: SAMPLE_PNG,
    });
    await expect(run).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(spawnedTools()).toEqual([]);
  });

  it('only refuses under STRICT_SANDBOX: a development host without namespaces still runs the tool', async () => {
    host.denyUnshare = true;
    resetUnshareCapabilityCache();
    const run = executeSandboxedBinary(process.env.PDFTOPPM_PATH!, ['-v'], { cwd: spyDir });
    await expect(run).rejects.toBeInstanceOf(SandboxedProcessError);
    expect(spawnedTools()).toEqual(['PDFTOPPM_PATH -v']);
  });

  // skip-ok: the control needs a host whose kernel really allows the namespaces the probe asks for.
  it.skipIf(skipUnless('unprivileged namespaces (unshare -r -n)', HAS_NAMESPACES))(
    'control: the same request starts the tool when the sandbox is available',
    async () => {
      vi.stubEnv('STRICT_SANDBOX', 'true');
      await v1ConvertPost(pdfToPngRequest('http://localhost/api/v1/convert'));
      expect(spawnedTools()[0]).toMatch(/^(PDFINFO_PATH|PDFTOPPM_PATH) /);
    },
    CONVERT_TIMEOUT_MS
  );
});

describe('SandboxUnavailableError in the job queue', () => {
  const refusal = new SandboxUnavailableError('Strict network isolation failed: Linux unshare capability is unavailable');

  it('is an engine-unavailable failure: 503, retried on another worker', () => {
    expect(refusal).toBeInstanceOf(EngineUnavailableError);
    expect(classifyJobFailure(refusal)).toEqual({ code: 'SandboxUnavailableError', status: HTTP_SERVICE_UNAVAILABLE, retryable: true });
  });

  it('is final only when the retries are used up, like any other missing engine', () => {
    expect(isFinalFailure({ attemptsMade: 1, opts: { attempts: QUEUE_ATTEMPTS } }, refusal)).toBe(false);
    expect(isFinalFailure({ attemptsMade: QUEUE_ATTEMPTS, opts: { attempts: QUEUE_ATTEMPTS } }, refusal)).toBe(true);
  });
});
