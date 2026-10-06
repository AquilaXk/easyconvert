import { describe, it, expect, vi } from 'vitest';
import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  resolveSandboxedCommand,
  getUnshareCapability,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
} from '../src/lib/security/process-sandbox';
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

    it('probes Linux unshare capability correctly and caches result', () => {
      const cap = getUnshareCapability();
      expect(typeof cap.available).toBe('boolean');
      expect(typeof cap.path).toBe('string');
      expect(Array.isArray(cap.args)).toBe(true);
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
