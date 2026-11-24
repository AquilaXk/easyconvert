import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineUnavailableError, PayloadLimitError, SandboxUnavailableError } from '../src/lib/types';
import { LIBREOFFICE_MEMORY_LIMIT_MB, LIBREOFFICE_POOL_ENGINE_NAME, LibreOfficePoolTimeoutError } from '../src/worker/libreoffice-pool';
import { convertWithHeadlessOffice, libreOfficePool, resetNativeBinaryCache, resolveNativeBinary } from '../src/worker/engines';
import { SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/worker/sandbox';

const sandboxSpies = vi.hoisted(() => ({
  executeSandboxedBinary: vi.fn(async (_binaryPath: string, args: string[]) => {
    const outDirIdx = args.indexOf('--outdir');
    const convertToIdx = args.indexOf('--convert-to');
    if (outDirIdx !== -1 && convertToIdx !== -1) {
      const outDir = args[outDirIdx + 1];
      const target = args[convertToIdx + 1].split(':')[0];
      const inputArg = args[args.length - 1];
      const stem = path.parse(inputArg).name;
      fs.writeFileSync(path.join(outDir, `${stem}.${target}`), Buffer.from('%PDF-1.4\n%%EOF\n'));
    }
    return {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      exitCode: 0,
      durationMs: 1,
      sandboxed: true,
      sandboxType: 'host' as const,
    };
  }),
}));

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return {
    ...actual,
    executeSandboxedBinary: sandboxSpies.executeSandboxedBinary,
  };
});

async function makeMinimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>');
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('runHeadlessOffice fails closed without unpooled soffice fallback', () => {
  let docxInput: Buffer;
  let tempDir: string;
  let fakeSoffice: string;
  let prevSofficePath: string | undefined;
  const createdOutputs: string[] = [];

  beforeAll(async () => {
    docxInput = await makeMinimalDocx();
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-no-fallback-'));
    fakeSoffice = path.join(tempDir, 'soffice');
    fs.writeFileSync(fakeSoffice, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    prevSofficePath = process.env.SOFFICE_PATH;
    process.env.SOFFICE_PATH = fakeSoffice;
    resetNativeBinaryCache();
    sandboxSpies.executeSandboxedBinary.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevSofficePath === undefined) {
      delete process.env.SOFFICE_PATH;
    } else {
      process.env.SOFFICE_PATH = prevSofficePath;
    }
    resetNativeBinaryCache();
    libreOfficePool.setSofficePath(resolveNativeBinary('soffice'));
    while (createdOutputs.length > 0) {
      const output = createdOutputs.pop();
      if (output) fs.rmSync(output, { force: true });
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects LibreOfficePoolTimeoutError with retryable EngineUnavailableError when throwOnUnavailable is true and never spawns standalone soffice', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    vi.spyOn(libreOfficePool, 'convert').mockRejectedValue(new LibreOfficePoolTimeoutError());

    let caught: unknown;
    try {
      await convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: true }, 'sample.docx');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(EngineUnavailableError);
    const unavailable = caught as EngineUnavailableError;
    expect(unavailable.refusalCode).toBe('engine_unavailable');
    expect(unavailable.retryable).toBe(true);
    expect(unavailable.engineName).toBe(LIBREOFFICE_POOL_ENGINE_NAME);
    expect(unavailable.engineName).toBe('libreoffice-pool');
    expect(sandboxSpies.executeSandboxedBinary).not.toHaveBeenCalled();
  });

  it('returns null without standalone soffice fallback on LibreOfficePoolTimeoutError when throwOnUnavailable is false', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    vi.spyOn(libreOfficePool, 'convert').mockRejectedValue(new LibreOfficePoolTimeoutError());

    const result = await convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false }, 'sample.docx');
    if (result?.filePath) createdOutputs.push(result.filePath);

    expect(result).toBeNull();
    expect(sandboxSpies.executeSandboxedBinary).not.toHaveBeenCalled();
  });

  it('returns null without standalone soffice fallback on generic pool conversion errors when throwOnUnavailable is false', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    vi.spyOn(libreOfficePool, 'convert').mockRejectedValue(
      new SandboxedProcessError('LibreOffice stopped while reading document', 1, 'conversion error')
    );

    const result = await convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false }, 'sample.docx');
    if (result?.filePath) createdOutputs.push(result.filePath);

    expect(result).toBeNull();
    expect(sandboxSpies.executeSandboxedBinary).not.toHaveBeenCalled();
  });

  it('rethrows generic pool conversion errors when throwOnUnavailable is true without standalone fallback', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    const failure = new Error('LibreOffice execution completed without producing expected output file');
    vi.spyOn(libreOfficePool, 'convert').mockRejectedValue(failure);

    await expect(
      convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: true }, 'sample.docx')
    ).rejects.toBe(failure);
    expect(sandboxSpies.executeSandboxedBinary).not.toHaveBeenCalled();
  });

  it('rethrows SandboxedMemoryLimitError (surfaced as PayloadLimitError), SandboxedTimeoutError, SandboxUnavailableError, and aborted AbortSignal even when throwOnUnavailable is false', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    const convertSpy = vi.spyOn(libreOfficePool, 'convert');

    convertSpy.mockRejectedValueOnce(new SandboxedMemoryLimitError(LIBREOFFICE_MEMORY_LIMIT_MB));
    await expect(
      convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false }, 'heavy.docx')
    ).rejects.toSatisfy((err: unknown) => err instanceof PayloadLimitError && err.message.includes(`${LIBREOFFICE_MEMORY_LIMIT_MB} MB`));

    const timeoutErr = new SandboxedTimeoutError(45_000);
    convertSpy.mockRejectedValueOnce(timeoutErr);
    await expect(
      convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false }, 'slow.docx')
    ).rejects.toBe(timeoutErr);

    const sandboxErr = new SandboxUnavailableError('user namespaces unavailable');
    convertSpy.mockRejectedValueOnce(sandboxErr);
    await expect(
      convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false }, 'confined.docx')
    ).rejects.toBe(sandboxErr);

    const controller = new AbortController();
    const abortErr = new Error('Client aborted request');
    convertSpy.mockImplementationOnce(async () => {
      controller.abort(abortErr);
      throw abortErr;
    });
    await expect(
      convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: false, signal: controller.signal }, 'aborted.docx')
    ).rejects.toBe(abortErr);

    expect(sandboxSpies.executeSandboxedBinary).not.toHaveBeenCalled();
  });

  it('uses standalone sandboxed soffice when libreOfficePool.isEnabled() is false', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(false);
    const poolConvertSpy = vi.spyOn(libreOfficePool, 'convert');

    const result = await convertWithHeadlessOffice(docxInput, 'docx', 'pdf', { throwOnUnavailable: true }, 'standalone.docx');
    if (result?.filePath) createdOutputs.push(result.filePath);

    expect(poolConvertSpy).not.toHaveBeenCalled();
    expect(sandboxSpies.executeSandboxedBinary).toHaveBeenCalledTimes(1);
    expect(sandboxSpies.executeSandboxedBinary.mock.calls[0]?.[0]).toBe(fakeSoffice);
    expect(result?.engineUsed).toBe('native-soffice');
  });

  it('uses standalone sandboxed soffice when keepEmbeddedExcelObjects is true even while pool is enabled', async () => {
    vi.spyOn(libreOfficePool, 'isEnabled').mockReturnValue(true);
    const poolConvertSpy = vi.spyOn(libreOfficePool, 'convert');

    const result = await convertWithHeadlessOffice(
      docxInput,
      'docx',
      'pdf',
      { keepEmbeddedExcelObjects: true, throwOnUnavailable: true },
      'embedded.docx'
    );
    if (result?.filePath) createdOutputs.push(result.filePath);

    expect(poolConvertSpy).not.toHaveBeenCalled();
    expect(sandboxSpies.executeSandboxedBinary).toHaveBeenCalledTimes(1);
    expect(sandboxSpies.executeSandboxedBinary.mock.calls[0]?.[0]).toBe(fakeSoffice);
    expect(result?.engineUsed).toBe('native-soffice');
  });
});
