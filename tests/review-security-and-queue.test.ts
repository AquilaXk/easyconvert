import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryTusSessionStore, TusEngine, setTusSessionStore } from '../src/lib/storage/tus-engine';
import { isBlockedIp } from '../src/lib/security/ssrf';
import { getNodeDependencies, normalizeGraphNodes, validateJobGraph } from '../src/lib/jobs/graph';
import { createStorageAdapter } from '../src/lib/storage/adapters/index';
import { DEFAULT_JWT_AUDIENCE, DEFAULT_JWT_ISSUER, signJwt, verifyJwt } from '../src/lib/auth/jwt';
import { createSessionToken, getSessionFromToken } from '../src/lib/auth/session';
import { redisUserStore } from '../src/lib/auth/redis-user-store';

describe('Security, Queue, Graph, Storage & Auth Regression Suite', () => {
  describe('CI-2: TusEngine concurrent sweep serialization', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-race-test-'));
      setTusSessionStore(new InMemoryTusSessionStore());
    });

    afterEach(() => {
      setTusSessionStore(null);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('waits for background createSession sweep before running explicit sweepExpired', async () => {
      const engine = new TusEngine({ tusDir: tmpDir, defaultTtlSeconds: 86_400 });
      await engine.createSession({ uploadLength: 64 });

      const orphanBin = path.join(tmpDir, `tus_${Date.now() - 3 * 86_400_000}_0123456789abcdef.bin`);
      fs.writeFileSync(orphanBin, Buffer.from('stale'));

      const swept = await engine.sweepExpired(Date.now());
      expect(swept).toBe(1);
      expect(fs.existsSync(orphanBin)).toBe(false);
    });
  });

  describe('SEC-1: SSRF IPv4/IPv6 canonical public-address blocking', () => {
    it('blocks benchmarking, TEST-NET, multicast, NAT64, and 6to4 loopback addresses', () => {
      expect(isBlockedIp('198.18.0.1')).toBe(true);
      expect(isBlockedIp('192.0.2.1')).toBe(true);
      expect(isBlockedIp('198.51.100.1')).toBe(true);
      expect(isBlockedIp('203.0.113.1')).toBe(true);
      expect(isBlockedIp('224.0.0.1')).toBe(true);
      expect(isBlockedIp('64:ff9b::a00:1')).toBe(true);
      expect(isBlockedIp('2002:7f00:0001::1')).toBe(true);
      expect(isBlockedIp('2001:db8::1')).toBe(true);
      expect(isBlockedIp('93.184.216.34')).toBe(false);
    });
  });

  describe('CONV-3: DAG Graph normalization and multi-input validation', () => {
    it('normalizes legacy inputs and dependencies fields into input for getNodeDependencies', () => {
      const normalized = normalizeGraphNodes({
        tasks: {
          u1: { operation: 'import/upload', storageKey: 'a.pdf' },
          u2: { operation: 'import/upload', storageKey: 'b.pdf' },
          m1: { operation: 'merge', inputs: ['u1', 'u2'], targetFormat: 'pdf' } as any,
          c1: { operation: 'convert', dependencies: ['m1'], targetFormat: 'png' } as any,
        },
      });

      expect(normalized.m1.input).toEqual(['u1', 'u2']);
      expect(normalized.c1.input).toBe('m1');
      expect(getNodeDependencies(normalized.m1)).toEqual(['u1', 'u2']);
      expect(getNodeDependencies(normalized.c1)).toEqual(['m1']);
    });

    it('validates all dependencies of multi-input convert nodes and rejects non-PDF upstream formats on PDF operations', () => {
      const badMultiConvert = validateJobGraph({
        nodes: {
          u1: { id: 'u1', op: 'import.upload', storageKey: 'a.png' },
          u2: { id: 'u2', op: 'import.upload', storageKey: 'b.mp3' },
          c1: { id: 'c1', op: 'convert', input: 'u1', targetFormat: 'jpg' },
          c2: { id: 'c2', op: 'convert', input: 'u2', targetFormat: 'wav' },
          bad: { id: 'bad', op: 'convert', input: ['c1', 'c2'], targetFormat: 'webp' },
          exp: { id: 'exp', op: 'export.url', input: 'bad' },
        },
      });
      expect(badMultiConvert.valid).toBe(false);
      expect(badMultiConvert.errors.some((e) => e.message.includes('wav') && e.message.includes('webp'))).toBe(true);

      const badPdfMerge = validateJobGraph({
        nodes: {
          u1: { id: 'u1', op: 'import.upload', storageKey: 'a.png' },
          u2: { id: 'u2', op: 'import.upload', storageKey: 'b.pdf' },
          c1: { id: 'c1', op: 'convert', input: 'u1', targetFormat: 'jpg' },
          m1: { id: 'm1', op: 'merge', input: ['c1', 'u2'], targetFormat: 'pdf' },
          exp: { id: 'exp', op: 'export.url', input: 'm1' },
        },
      });
      expect(badPdfMerge.valid).toBe(false);
      expect(badPdfMerge.errors.some((e) => e.code === 'INCOMPATIBLE_MERGE_INPUT')).toBe(true);

      const badRotate = validateJobGraph({
        nodes: {
          u1: { id: 'u1', op: 'import.upload', storageKey: 'a.png' },
          c1: { id: 'c1', op: 'convert', input: 'u1', targetFormat: 'jpg' },
          r1: { id: 'r1', op: 'pdf.rotate-pages', input: 'c1', options: { angle: 90 } as any },
          exp: { id: 'exp', op: 'export.url', input: 'r1' },
        },
      });
      expect(badRotate.valid).toBe(false);
      expect(badRotate.errors.some((e) => e.message.includes('requires PDF input'))).toBe(true);
    });
  });

  describe('SEC-4: BYOS Storage adapter credential validation and key traversal protection', () => {
    it('rejects SSRF endpoints and invalid GCS buckets in createStorageAdapter', () => {
      expect(() =>
        createStorageAdapter({
          type: 's3',
          bucket: 'valid-bucket',
          region: 'us-east-1',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          endpoint: 'https://169.254.169.254/latest/meta-data',
        })
      ).toThrow(/SSRF|private|blocked|restricted/i);

      expect(() =>
        createStorageAdapter({
          type: 'gcs',
          projectId: 'my-project',
          bucket: '../evil-bucket',
          clientEmail: 'svc@project.iam.gserviceaccount.com',
          privateKey: '-----BEGIN PRIVATE KEY-----\nMIIB...\n-----END PRIVATE KEY-----',
        })
      ).toThrow(/bucket/i);
    });

    it('rejects traversal segments and backslashes in WebDAV and Azure Blob keys', async () => {
      const webdav = createStorageAdapter({
        type: 'webdav',
        url: 'https://storage.example.com/dav',
        username: 'user',
        password: 'password123',
      });
      await expect(webdav.head('../secret.txt')).rejects.toThrow(/traversal|invalid|\.\./i);
      await expect(webdav.head('folder\\secret.txt')).rejects.toThrow(/backslash|invalid/i);

      const azure = createStorageAdapter({
        type: 'azure-blob',
        storageAccount: 'myaccount',
        containerName: 'mycontainer',
        sasToken: 'sv=2022-11-02&ss=b&srt=sco&sp=rwdlaciyx&se=2099-01-01T00:00:00Z&sig=abc',
      });
      await expect(azure.head('../secret.txt')).rejects.toThrow(/traversal|invalid|\.\./i);
      await expect(azure.head('folder\\secret.txt')).rejects.toThrow(/backslash|invalid/i);
    });
  });

  describe('SEC-6: JWT exp/iss/aud claim enforcement', () => {
    beforeEach(() => {
      redisUserStore.resetStore();
    });

    it('rejects tokens missing exp or carrying mismatched issuer/audience', async () => {
      const secret = 'test-jwt-secret-with-at-least-32-bytes!!';
      const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
      const payloadNoExpB64 = Buffer.from(
        JSON.stringify({ sub: 'u1', iss: DEFAULT_JWT_ISSUER, aud: DEFAULT_JWT_AUDIENCE })
      ).toString('base64url');
      const crypto = await import('node:crypto');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(`${headerB64}.${payloadNoExpB64}`)
        .digest('base64url');
      const tokenWithoutExp = `${headerB64}.${payloadNoExpB64}.${sig}`;

      expect(verifyJwt(tokenWithoutExp, secret)).toBeNull();

      const validToken = signJwt({ sub: 'u1' }, { secret, issuer: DEFAULT_JWT_ISSUER, audience: DEFAULT_JWT_AUDIENCE });
      expect(verifyJwt(validToken, secret, { issuer: DEFAULT_JWT_ISSUER, audience: DEFAULT_JWT_AUDIENCE })).not.toBeNull();
      expect(verifyJwt(validToken, secret, { issuer: 'other-issuer', audience: DEFAULT_JWT_AUDIENCE })).toBeNull();
      expect(verifyJwt(validToken, secret, { issuer: DEFAULT_JWT_ISSUER, audience: 'other-audience' })).toBeNull();

      const user = await redisUserStore.createUser({
        email: 'jwt-claim@example.com',
        name: 'JWT Claim User',
        tier: 'free',
      });
      const validSessionToken = createSessionToken(user);
      expect((await getSessionFromToken(validSessionToken))?.id).toBe(user.id);

      const wrongAudToken = signJwt(
        { sub: user.id, email: user.email, name: user.name, tier: user.tier },
        {
          issuer: DEFAULT_JWT_ISSUER,
          audience: 'wrong-audience',
        }
      );
      expect(await getSessionFromToken(wrongAudToken)).toBeNull();
    });
  });
});
