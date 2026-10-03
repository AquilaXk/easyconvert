import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeSandboxedBinary,
  SandboxedProcessError,
  SandboxedMemoryLimitError,
} from '../src/lib/security/process-sandbox';
import {
  convertWithHeadlessOffice,
  executeWorkerConversion,
  EngineUnavailableError,
  libreOfficePool,
} from '../src/worker/engines';
import { createZipArchive } from '../src/lib/conversions';
import { ociWorker } from '../src/worker/index';
import type { Job } from '../src/lib/queue/bullmq-engine';
import type { ConversionJobData, ConversionJobResult } from '../src/lib/types';

describe('PR 0-A: Sandbox Signal Exits & Fail-Closed Guardrails', () => {
  describe('1. Sandbox Process Signal Termination Handling', () => {
    it('rejects with SandboxedProcessError when child is killed by SIGKILL', async () => {
      let caughtError: unknown = null;
      try {
        await executeSandboxedBinary('/bin/sh', ['-c', 'kill -9 $$']);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SandboxedProcessError);
      const processError = caughtError as SandboxedProcessError;
      expect(processError.signal).toBe('SIGKILL');
      expect(processError.exitCode).toBeNull();
      expect(processError.message).toMatch(/signal SIGKILL/i);
    });

    it('rejects with SandboxedProcessError when child is killed by SIGSEGV', async () => {
      let caughtError: unknown = null;
      try {
        await executeSandboxedBinary('/bin/sh', ['-c', 'kill -11 $$']);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SandboxedProcessError);
      const processError = caughtError as SandboxedProcessError;
      expect(processError.signal).toBe('SIGSEGV');
      expect(processError.exitCode).toBeNull();
      expect(processError.message).toMatch(/signal SIGSEGV/i);
    });

    it('rejects with SandboxedMemoryLimitError when child receives SIGKILL under memory limit', async () => {
      let caughtError: unknown = null;
      try {
        await executeSandboxedBinary('/bin/sh', ['-c', 'kill -9 $$'], {
          memoryLimitMb: 64,
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(SandboxedMemoryLimitError);
      const memError = caughtError as SandboxedMemoryLimitError;
      expect(memError.limitMb).toBe(64);
      expect(memError.message).toContain('64MB');
    });

    it('aborts process execution when AbortSignal triggers', async () => {
      const controller = new AbortController();
      const runPromise = executeSandboxedBinary('/bin/sleep', ['5'], {
        signal: controller.signal,
      });

      setTimeout(() => {
        controller.abort(new Error('Process cancelled by client'));
      }, 50);

      await expect(runPromise).rejects.toThrow('Process cancelled by client');
    });

    it('immediately rejects if AbortSignal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort(new Error('Pre-aborted signal'));

      await expect(
        executeSandboxedBinary('/bin/sleep', ['1'], {
          signal: controller.signal,
        })
      ).rejects.toThrow('Pre-aborted signal');
    });
  });

  describe('2. Native Engine Swallowed Error Elimination & No-Output Fail-Closed', () => {
    it('fails closed when LibreOffice execution completes without creating output file', async () => {
      // Create a temporary mock script that succeeds (exit 0) but writes NO output file
      const tempScriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-soffice-'));
      const mockScriptPath = path.join(tempScriptDir, 'mock-soffice.sh');
      fs.writeFileSync(mockScriptPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const prevSoffice = process.env.SOFFICE_PATH;
      process.env.SOFFICE_PATH = mockScriptPath;

      try {
        const dummyDoc = Buffer.from('PK\x03\x04Dummy docx content');
        await expect(
          convertWithHeadlessOffice(dummyDoc, 'docx', 'pdf', { throwOnUnavailable: true }, 'sample.docx')
        ).rejects.toThrow(/LibreOffice execution completed without producing expected output file/);
      } finally {
        if (prevSoffice !== undefined) {
          process.env.SOFFICE_PATH = prevSoffice;
        } else {
          delete process.env.SOFFICE_PATH;
        }
        libreOfficePool.setSofficePath(null);
        try {
          fs.rmSync(tempScriptDir, { recursive: true, force: true });
        } catch {}
      }
    });

    it('forbids fallback to pure TypeScript engine when pdfStandard is requested', async () => {
      // Direct pure TS fallback path explicitly forbids pdfStandard
      const dummyText = Buffer.from('Plain text document');
      await expect(
        executeWorkerConversion(dummyText, 'txt', 'pdf', {
          pdfStandard: 'pdfa-1b',
        })
      ).rejects.toThrow(/pdfStandard/);
    });

    it('fails closed when input payload lacks both inputPath and inputBuffer (no Buffer.alloc(0) fake)', async () => {
      await expect(
        executeWorkerConversion({} as any, 'txt', 'pdf')
      ).rejects.toThrow(/neither inputPath nor inputBuffer provided|no valid inputBuffer or inputPath/);
    });

    it('attaches fallbackReason to result metadata when falling back due to EngineUnavailableError', async () => {
      // Force engine unavailability via environment override for deterministic behavior across environments
      const prevP7zip = process.env.P7ZIP_PATH;
      process.env.P7ZIP_PATH = '/nonexistent/7z';

      try {
        const zipRes = await createZipArchive([{ filename: 'test.txt', buffer: Buffer.from('hello') }]);
        const res = await executeWorkerConversion(zipRes.buffer, 'zip', 'tar', {}, 'archive.zip');

        expect(res.engineUsed).toBe('internal-fallback');
        expect(res.metadata).toBeDefined();
        expect(typeof res.metadata?.fallbackReason).toBe('string');
        expect(res.metadata?.fallbackReason).toMatch(/7-Zip|not installed/);
        expect(res.fallbackReason).toBe(res.metadata?.fallbackReason);
      } finally {
        if (prevP7zip !== undefined) {
          process.env.P7ZIP_PATH = prevP7zip;
        } else {
          delete process.env.P7ZIP_PATH;
        }
      }
    });
  });

  describe('3. OCI Worker Multi-Stage Task Rejection & Signal Propagation', () => {
    it('rejects multi-stage pipeline tasks until Phase 3 DAG orchestration lands', async () => {
      const mockJob = {
        id: 'job-multi-task-123',
        data: {
          jobId: 'job-multi-task-123',
          originalFilename: 'document.docx',
          sourceFormat: 'docx',
          targetFormat: 'txt',
          fileSize: 1024,
          inputBufferBase64: Buffer.from('test data').toString('base64'),
          options: {},
          tasks: [
            { name: 'step1', operation: 'convert', targetFormat: 'pdf' },
            { name: 'step2', operation: 'ocr', targetFormat: 'txt' },
          ],
        },
        signal: new AbortController().signal,
        log: vi.fn().mockResolvedValue(undefined),
        updateProgress: vi.fn().mockResolvedValue(undefined),
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      // Execute worker job processor
      await expect(
        (ociWorker as any).processor(mockJob)
      ).rejects.toThrow(/Multi-stage pipeline tasks \(length 2\) are not supported in worker until DAG orchestration/);
    });

    it('allows single-stage jobs through worker and cleans up on completion', async () => {
      const mockJob = {
        id: 'job-single-task-123',
        data: {
          jobId: 'job-single-task-123',
          originalFilename: 'document.txt',
          sourceFormat: 'txt',
          targetFormat: 'zip',
          fileSize: 20,
          inputBufferBase64: Buffer.from('Single stage test').toString('base64'),
          options: {},
          tasks: [{ name: 'step1', operation: 'convert', targetFormat: 'zip' }],
        },
        signal: new AbortController().signal,
        log: vi.fn().mockResolvedValue(undefined),
        updateProgress: vi.fn().mockResolvedValue(undefined),
      } as unknown as Job<ConversionJobData, ConversionJobResult>;

      const result = await (ociWorker as any).processor(mockJob);
      expect(result.status).toBe('completed');
      expect(result.filename).toBe('document.zip');
    });
  });
});
