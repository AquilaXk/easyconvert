import { describe, it, expect, vi } from 'vitest';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
} from '../src/lib/security/process-sandbox';
import {
  isPdf,
  isPdfVulnerableToActiveContent,
  sanitizePdf,
} from '../src/lib/security/pdf-sanitizer';
import {
  secureShredBuffer,
  secureWipeObject,
} from '../src/lib/security/memory-shredder';
import { OciObjectStorageService } from '../src/lib/storage/oci-storage';

describe('Phase 3: Zero-Trust Enterprise Security, Sandboxing & Privacy Hardening (#68)', () => {
  // =========================================================================
  // 1. Process Sandbox Hardening & Environment Sanitization
  // =========================================================================
  describe('1. Process Sandbox Hardening & Environment Sanitization', () => {
    it('purges sensitive environment variables and credentials', () => {
      const dirtyEnv = {
        API_KEY: 'secret-key-12345',
        DATABASE_PASSWORD: 'supersecretpass',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        OCI_AUTH_TOKEN: 'oci-token',
        AUTH_BEARER: 'bearer-jwt',
        SAFE_VARIABLE: 'safe-value-ok',
      };

      const clean = getSanitizedEnvironment(dirtyEnv, true);
      expect(clean.API_KEY).toBeUndefined();
      expect(clean.DATABASE_PASSWORD).toBeUndefined();
      expect(clean.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(clean.OCI_AUTH_TOKEN).toBeUndefined();
      expect(clean.AUTH_BEARER).toBeUndefined();
      expect(clean.SAFE_VARIABLE).toBe('safe-value-ok');
    });

    it('injects network isolation guards when networkIsolated is true', () => {
      const clean = getSanitizedEnvironment({}, true);
      expect(clean.http_proxy).toBe('http://127.0.0.1:0');
      expect(clean.https_proxy).toBe('http://127.0.0.1:0');
      expect(clean.ALL_PROXY).toBe('socks5://127.0.0.1:0');
      expect(clean.NO_PROXY).toBe('');
    });

    it('resolveSandboxedCommand preserves commands or wraps with unshare on Linux', () => {
      const res = resolveSandboxedCommand('/bin/echo', ['hello'], true);
      expect(res.binary).toBeDefined();
      if (res.wrapped) {
        expect(res.binary).toMatch(/unshare$/);
        expect(res.args).toContain('-n');
        expect(res.args).toContain('/bin/echo');
      } else {
        expect(res.binary).toBe('/bin/echo');
        expect(res.args).toEqual(['hello']);
      }
    });

    it('enforces execution timeout and throws SandboxedTimeoutError', async () => {
      // Execute command that sleeps longer than timeout
      const sleepCmd = process.platform === 'win32' ? 'powershell' : 'sleep';
      const sleepArgs = process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 2'] : ['2'];

      await expect(
        executeSandboxedBinary(sleepCmd, sleepArgs, {
          timeoutMs: 100,
        })
      ).rejects.toThrow(SandboxedTimeoutError);
    });

    it('enforces buffer threshold and throws SandboxedBufferLimitError', async () => {
      const nodeBin = process.execPath;
      // Output 100KB while limit is 10KB
      const args = ['-e', 'process.stdout.write("A".repeat(100 * 1024))'];

      await expect(
        executeSandboxedBinary(nodeBin, args, {
          maxBuffer: 10 * 1024,
        })
      ).rejects.toThrow(SandboxedBufferLimitError);
    });
  });

  // =========================================================================
  // 2. PDF Content Disarm & Reconstruction (CDR) Sanitization
  // =========================================================================
  describe('2. PDF Content Disarm & Reconstruction (CDR) Sanitization', () => {
    it('detects valid PDF header correctly', () => {
      const validPdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF');
      expect(isPdf(validPdf)).toBe(true);

      const invalidPdf = Buffer.from('Not a PDF file');
      expect(isPdf(invalidPdf)).toBe(false);
    });

    it('detects active executable exploit content in PDF', () => {
      const cleanPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF');
      expect(isPdfVulnerableToActiveContent(cleanPdf)).toBe(false);

      const jsPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /S /JavaScript /JS (app.alert("XSS")) >>\nendobj\n%%EOF');
      expect(isPdfVulnerableToActiveContent(jsPdf)).toBe(true);

      const launchPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /S /Launch /F (cmd.exe) >>\nendobj\n%%EOF');
      expect(isPdfVulnerableToActiveContent(launchPdf)).toBe(true);

      const openActionPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /OpenAction 2 0 R >>\nendobj\n%%EOF');
      expect(isPdfVulnerableToActiveContent(openActionPdf)).toBe(true);
    });

    it('disarms multiple exploit vectors and produces clean CDR report', () => {
      const maliciousPdf = Buffer.from(`%PDF-1.7
1 0 obj
<<
  /Type /Catalog
  /Pages 2 0 R
  /OpenAction 3 0 R
  /AA << /O 4 0 R >>
>>
endobj
3 0 obj
<<
  /Type /Action
  /S /Launch
  /F (powershell.exe -enc ...)
>>
endobj
4 0 obj
<<
  /Type /Action
  /S /JavaScript
  /JS (eval("maliciousPayload()"))
>>
endobj
5 0 obj
<<
  /Names << /EmbeddedFiles 6 0 R >>
>>
endobj
6 0 obj
<<
  /Type /Action
  /S /SubmitForm
>>
endobj
%%EOF`);

      const { buffer, report } = sanitizePdf(maliciousPdf);
      const sanitizedText = buffer.toString('latin1');

      // Threats must be disarmed
      expect(report.isSanitized).toBe(true);
      expect(report.totalThreats).toBeGreaterThanOrEqual(5);
      expect(report.threatsRemoved.launchCount).toBeGreaterThanOrEqual(1);
      expect(report.threatsRemoved.javaScriptCount).toBeGreaterThanOrEqual(1);
      expect(report.threatsRemoved.openActionCount).toBeGreaterThanOrEqual(1);
      expect(report.threatsRemoved.additionalActionsCount).toBeGreaterThanOrEqual(1);

      // Sanitized text must not contain active executable actions
      expect(sanitizedText).not.toContain('/S /JavaScript');
      expect(sanitizedText).not.toContain('/S /Launch');
      expect(sanitizedText).not.toContain('/S /SubmitForm');
      expect(sanitizedText).not.toContain('/OpenAction');
      expect(sanitizedText).not.toContain('/AA');
      expect(sanitizedText).toContain('/S /None');
      expect(sanitizedText).toContain('%PDF-');
    });

    it('throws error when attempting to sanitize non-PDF buffers', () => {
      const invalid = Buffer.from('Plain text content');
      expect(() => sanitizePdf(invalid)).toThrow(/missing %PDF- header/);
    });
  });

  // =========================================================================
  // 3. Cryptographic Memory Buffer Shredding (DoD 5220.22-M / NIST SP 800-88)
  // =========================================================================
  describe('3. Cryptographic Memory Buffer Shredding', () => {
    it('overwrites buffer contents with multi-pass random data and zeros out completely', () => {
      const secret = Buffer.from('Confidential user document payload containing PII');
      expect(secret[0]).not.toBe(0);

      secureShredBuffer(secret, 2);

      // After shredding, all bytes must be strictly zeroed out
      expect(secret.every((b) => b === 0)).toBe(true);
      expect(secret.toString('utf-8')).not.toContain('Confidential');
    });

    it('secureWipeObject recursively shreds all buffer properties in object tree', () => {
      const sensitiveSession = {
        sessionId: 'sess_123',
        payload: Buffer.from('Sensitive payload 1'),
        nested: {
          subPayload: Buffer.from('Sensitive payload 2'),
          meta: 'public',
        },
      };

      const ref1 = sensitiveSession.payload;
      const ref2 = sensitiveSession.nested.subPayload;

      secureWipeObject(sensitiveSession);

      expect(ref1.every((b) => b === 0)).toBe(true);
      expect(ref2.every((b) => b === 0)).toBe(true);
      expect(sensitiveSession.payload).toBeUndefined();
      expect(sensitiveSession.nested.subPayload).toBeUndefined();
      expect(sensitiveSession.nested.meta).toBe('public');
    });

    it('integrates multi-pass shredding with OCI storage lifecycle and TTL disposal', () => {
      const storage = new OciObjectStorageService();
      try {
        const key = 'test-shred-integration';
        const rawBuf = Buffer.from('Important transient file awaiting conversion');
        const stored = storage.saveObject(key, rawBuf, 'text/plain', 'test.txt');

        const bufferRef = stored.buffer;
        expect(bufferRef[0]).not.toBe(0);

        // Delete object: must trigger multi-pass shredding
        storage.deleteObject(key);

        expect(bufferRef.every((b) => b === 0)).toBe(true);
        expect(storage.getObject(key)).toBeUndefined();
      } finally {
        storage.stopGc();
      }
    });
  });
});
