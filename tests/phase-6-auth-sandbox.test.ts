import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkerSandboxDir,
  cleanupWorkerSandboxDir,
  sanitizeWorkerEnvironment,
  withWorkerSandbox,
  runInWorkerSandbox,
} from '../src/worker/sandbox';
import {
  RedisUserStore,
  CREATE_USER_LUA_SCRIPT,
  UPDATE_USER_LUA_SCRIPT,
  RECORD_CONVERSION_LUA_SCRIPT,
} from '../src/lib/auth/redis-user-store';
import {
  RedisKeyStore,
  DEDUCT_QUOTA_LUA_SCRIPT,
  RESERVE_QUOTA_LUA_SCRIPT,
  COMMIT_QUOTA_LUA_SCRIPT,
  ROLLBACK_QUOTA_LUA_SCRIPT,
} from '../src/lib/api-keys/redis-key-store';
import { userStore } from '../src/lib/auth/user-store';

describe('Phase 6: Distributed Auth & Worker Sandbox Hardening', () => {
  // ==========================================================================
  // 1. Worker Sandbox Isolation & Ephemeral 0o700 Directory
  // ==========================================================================
  describe('1. Worker Sandbox Isolation & Ephemeral 0o700 Directory', () => {
    let createdSandboxDirs: string[] = [];

    afterEach(() => {
      for (const dir of createdSandboxDirs) {
        cleanupWorkerSandboxDir(dir);
      }
      createdSandboxDirs = [];
    });

    it('creates dedicated ephemeral sandbox directory with 0o700 permission mask', () => {
      const sandboxDir = createWorkerSandboxDir('test_sandbox_');
      createdSandboxDirs.push(sandboxDir);

      expect(fs.existsSync(sandboxDir)).toBe(true);
      expect(path.isAbsolute(sandboxDir)).toBe(true);

      const stat = fs.statSync(sandboxDir);
      expect(stat.isDirectory()).toBe(true);

      // On POSIX platforms, verify 0o700 (user rwx only, group/others none)
      if (process.platform !== 'win32') {
        const mode = stat.mode & 0o777;
        expect(mode).toBe(0o700);
      }
    });

    it('cleans up sandbox directory idempotently and tolerates non-existent paths', () => {
      const sandboxDir = createWorkerSandboxDir('test_cleanup_');
      expect(fs.existsSync(sandboxDir)).toBe(true);

      cleanupWorkerSandboxDir(sandboxDir);
      expect(fs.existsSync(sandboxDir)).toBe(false);

      // Second invocation should not throw
      expect(() => cleanupWorkerSandboxDir(sandboxDir)).not.toThrow();
      expect(() => cleanupWorkerSandboxDir('/non/existent/path/12345')).not.toThrow();
    });

    it('sanitizes and purges sensitive tokens and credentials from worker environment', () => {
      const dirtyEnv = {
        AWS_SECRET_ACCESS_KEY: 'super-secret-aws-key',
        REDIS_URL: 'redis://:password@10.0.0.1:6379',
        DATABASE_URL: 'postgres://admin:secret@db:5432/main',
        GITHUB_TOKEN: 'ghp_secret_token_12345',
        STRIPE_SECRET_KEY: 'sk_live_secret_key',
        USER_ID: 'user-normal-123',
        CUSTOM_OPTION: 'safe-value',
      };

      const sandboxDir = createWorkerSandboxDir('test_env_');
      createdSandboxDirs.push(sandboxDir);

      const sanitized = sanitizeWorkerEnvironment(dirtyEnv, sandboxDir, true);

      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(sanitized.REDIS_URL).toBeUndefined();
      expect(sanitized.DATABASE_URL).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.STRIPE_SECRET_KEY).toBeUndefined();

      expect(sanitized.USER_ID).toBe('user-normal-123');
      expect(sanitized.CUSTOM_OPTION).toBe('safe-value');
      expect(sanitized.TMPDIR).toBe(sandboxDir);
      expect(sanitized.HOME).toBe(sandboxDir);
      expect(sanitized.HTTP_PROXY).toBe('http://127.0.0.1:0');
    });

    it('withWorkerSandbox executes work inside ephemeral directory and guarantees teardown cleanup', async () => {
      let observedSandboxDir = '';
      let testFilePath = '';

      await withWorkerSandbox(async (ctx) => {
        observedSandboxDir = ctx.sandboxDir;
        expect(fs.existsSync(observedSandboxDir)).toBe(true);

        testFilePath = path.join(ctx.sandboxDir, 'intermediate_buffer.bin');
        fs.writeFileSync(testFilePath, Buffer.from('sandboxed-data-payload'));
        expect(fs.existsSync(testFilePath)).toBe(true);

        return 'success';
      });

      // After withWorkerSandbox completes, both directory and files must be deleted
      expect(observedSandboxDir.length).toBeGreaterThan(0);
      expect(fs.existsSync(observedSandboxDir)).toBe(false);
      expect(fs.existsSync(testFilePath)).toBe(false);
    });

    it('withWorkerSandbox cleans up ephemeral directory even when callback throws an error', async () => {
      let leakedDir = '';

      await expect(
        withWorkerSandbox(async (ctx) => {
          leakedDir = ctx.sandboxDir;
          fs.writeFileSync(path.join(ctx.sandboxDir, 'crash.log'), 'error data');
          throw new Error('Forced simulation crash inside worker sandbox');
        })
      ).rejects.toThrow('Forced simulation crash inside worker sandbox');

      expect(leakedDir.length).toBeGreaterThan(0);
      expect(fs.existsSync(leakedDir)).toBe(false);
    });

    it('runInWorkerSandbox runs command with ephemeral 0o700 isolation and cleans up', async () => {
      const echoPath = fs.existsSync('/bin/echo') ? '/bin/echo' : '/usr/bin/echo';
      const result = await runInWorkerSandbox(echoPath, ['sandbox-ok']);

      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString('utf-8').trim()).toBe('sandbox-ok');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('runInWorkerSandbox injects ephemeral sandboxDir into process environment (TMPDIR, HOME)', async () => {
      const envBin = process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/env';
      const result = await runInWorkerSandbox(envBin, []);

      expect(result.exitCode).toBe(0);
      const out = result.stdout.toString('utf-8');
      const lines = out.split('\n');
      const tmpdirLine = lines.find((l) => l.startsWith('TMPDIR='));
      const homeLine = lines.find((l) => l.startsWith('HOME='));

      expect(tmpdirLine).toBeDefined();
      expect(homeLine).toBeDefined();

      const tmpdirVal = tmpdirLine!.split('=')[1].trim();
      const homeVal = homeLine!.split('=')[1].trim();

      expect(tmpdirVal).toContain('easyconvert_worker_sandbox_');
      expect(homeVal).toContain('easyconvert_worker_sandbox_');
      expect(tmpdirVal).toBe(homeVal);

      // Ephemeral directory must be already cleaned up after execution completes
      expect(fs.existsSync(tmpdirVal)).toBe(false);
    });

    it('withWorkerSandbox guarantees cleanup even when ENOSPC disk-full error occurs', async () => {
      let trappedDir = '';
      await expect(
        withWorkerSandbox(async (ctx) => {
          trappedDir = ctx.sandboxDir;
          const enospcError = new Error('ENOSPC: no space left on device, write');
          (enospcError as any).code = 'ENOSPC';
          throw enospcError;
        })
      ).rejects.toThrow(/ENOSPC/);

      expect(trappedDir.length).toBeGreaterThan(0);
      expect(fs.existsSync(trappedDir)).toBe(false);
    });
  });

  // ==========================================================================
  // 2. Distributed Redis User Store
  // ==========================================================================
  describe('2. Distributed Redis User Store', () => {
    let store: RedisUserStore;

    beforeEach(() => {
      store = new RedisUserStore({ keyPrefix: 'test:user:' });
      store.resetStore();
    });

    afterEach(() => {
      store.resetStore();
    });

    it('exposes well-formed atomic Lua script definitions', () => {
      expect(CREATE_USER_LUA_SCRIPT).toContain("redis.call('EXISTS'");
      expect(CREATE_USER_LUA_SCRIPT).toContain("redis.call('SET'");
      expect(UPDATE_USER_LUA_SCRIPT).toContain("redis.call('GET'");
      expect(RECORD_CONVERSION_LUA_SCRIPT).toContain("redis.call('GET'");
      expect(store.getKeyPrefix()).toBe('test:user:');
    });

    it('verifies connectivity and health ping', async () => {
      const ping = await store.ping();
      expect(ping.ok).toBe(true);
      expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('creates, retrieves, and updates users in distributed in-memory fallback mode', async () => {
      store.setDistributed(true);
      expect(store.isDistributed()).toBe(true);

      const user = await store.createUser({
        email: 'Enterprise.Worker@Example.COM',
        name: 'Enterprise Worker',
        tier: 'pro',
      });

      expect(user.id).toBeDefined();
      expect(user.email).toBe('enterprise.worker@example.com'); // normalized
      expect(user.tier).toBe('pro');

      // Find by ID and email
      const foundById = await store.findById(user.id);
      expect(foundById?.name).toBe('Enterprise Worker');

      const foundByEmail = await store.findByEmail('enterprise.worker@example.com');
      expect(foundByEmail?.id).toBe(user.id);

      // Record conversion
      await store.recordConversion(user.id);
      const afterConversion = await store.findById(user.id);
      expect(afterConversion?.conversionsCount).toBe(1);

      // Update tier
      await store.updateTier(user.id, 'enterprise');
      const updated = await store.findById(user.id);
      expect(updated?.tier).toBe('enterprise');
    });

    it('fails closed when attempting to create a user with invalid or duplicate email', async () => {
      store.setDistributed(true);

      // Invalid email
      await expect(
        store.createUser({ email: 'not-an-email', name: 'Invalid User' })
      ).rejects.toThrow(/Invalid email format/);

      // Empty name
      await expect(
        store.createUser({ email: 'valid@example.com', name: '   ' })
      ).rejects.toThrow(/Invalid name/);

      // Duplicate email
      await store.createUser({ email: 'dupe@example.com', name: 'First User' });
      await expect(
        store.createUser({ email: 'DUPE@example.com', name: 'Second User' })
      ).rejects.toThrow(/already exists/);
    });
  });

  // ==========================================================================
  // 3. Distributed Redis Key Store & Quota Management
  // ==========================================================================
  describe('3. Distributed Redis Key Store & Quota Management', () => {
    let keyStore: RedisKeyStore;
    let testUserId: string;

    beforeEach(async () => {
      keyStore = new RedisKeyStore('test:keystore:');
      userStore.resetStore();

      const user = await userStore.createUser({
        email: 'quota-tester@example.com',
        name: 'Quota Tester',
        tier: 'free', // 25 daily units
      });
      testUserId = user.id;
    });

    afterEach(() => {
      userStore.resetStore();
    });

    it('exposes well-formed atomic Lua scripts for quota operations', () => {
      expect(RESERVE_QUOTA_LUA_SCRIPT).toContain("redis.call('INCRBY'");
      expect(COMMIT_QUOTA_LUA_SCRIPT).toContain("redis.call('DEL'");
      expect(ROLLBACK_QUOTA_LUA_SCRIPT).toContain("redis.call('DECRBY'");
      expect(DEDUCT_QUOTA_LUA_SCRIPT).toContain("redis.call('INCRBY'");
      expect(keyStore.getPrefix()).toBe('test:keystore:');
    });

    it('deducts quota directly and enforces tier boundaries', async () => {
      // Free tier has 25 units limit
      const deduction1 = await keyStore.deductQuota(testUserId, 10);
      expect(deduction1.allowed).toBe(true);
      expect(deduction1.remaining).toBe(15);

      const deduction2 = await keyStore.deductQuota(testUserId, 15);
      expect(deduction2.allowed).toBe(true);
      expect(deduction2.remaining).toBe(0);

      // Exceeds quota
      const deductionExceeded = await keyStore.deductQuota(testUserId, 1);
      expect(deductionExceeded.allowed).toBe(false);
      expect(deductionExceeded.remaining).toBe(0);
    });

    it('fails closed on invalid quota parameters (negative, NaN, empty userId)', async () => {
      const invalidUnits = await keyStore.deductQuota(testUserId, -5);
      expect(invalidUnits.allowed).toBe(false);
      expect(invalidUnits.remaining).toBe(0);

      const nanUnits = await keyStore.deductQuota(testUserId, NaN);
      expect(nanUnits.allowed).toBe(false);
      expect(nanUnits.remaining).toBe(0);

      const emptyUser = await keyStore.deductQuota('', 1);
      expect(emptyUser.allowed).toBe(false);
      expect(emptyUser.remaining).toBe(0);
    });

    it('executes 2-phase quota transactions (reserve -> commit)', async () => {
      const initialActive = keyStore.getActiveReservationsCount();
      expect(initialActive).toBe(0);

      // Phase 1: Reserve 5 units
      const res = await keyStore.reserveQuota(testUserId, 5);
      expect(res.allowed).toBe(true);
      expect(res.reservationId).toBeDefined();
      expect(res.remaining).toBe(20);

      expect(keyStore.getActiveReservationsCount()).toBe(1);
      const reservation = keyStore.getReservation(res.reservationId!);
      expect(reservation?.units).toBe(5);
      expect(reservation?.status).toBe('reserved');

      // Phase 2a: Commit reservation
      const committed = await keyStore.commitQuota(res.reservationId!);
      expect(committed).toBe(true);
      expect(keyStore.getActiveReservationsCount()).toBe(0);

      // Trying to commit twice returns false
      expect(await keyStore.commitQuota(res.reservationId!)).toBe(false);
    });

    it('executes 2-phase quota transactions (reserve -> rollback/refund)', async () => {
      // Reserve 8 units
      const res = await keyStore.reserveQuota(testUserId, 8);
      expect(res.allowed).toBe(true);
      expect(res.remaining).toBe(17);

      // Rollback reservation
      const rolledBack = await keyStore.rollbackQuota(res.reservationId!);
      expect(rolledBack).toBe(true);
      expect(keyStore.getActiveReservationsCount()).toBe(0);

      // Remaining should be restored to 25
      const probe = await keyStore.reserveQuota(testUserId, 0);
      expect(probe.remaining).toBe(25);
    });

    it('cleans up and refunds expired reservations automatically', async () => {
      const res = await keyStore.reserveQuota(testUserId, 10);
      expect(res.allowed).toBe(true);

      const reservation = keyStore.getReservation(res.reservationId!);
      expect(reservation).toBeDefined();

      // Simulate reservation expiration
      if (reservation) {
        reservation.expiresAt = Date.now() - 1000; // 1 second ago
      }

      const cleaned = keyStore.cleanExpiredReservations();
      expect(cleaned).toBe(1);
      expect(keyStore.getActiveReservationsCount()).toBe(0);

      // Quota should be restored to full 25
      const probe = await keyStore.reserveQuota(testUserId, 0);
      expect(probe.remaining).toBe(25);
    });

    it('unifies keyStore and redisKeyStore state and eliminates decoupled disk overwrites', async () => {
      const { keyStore: defaultKeyStore, KeyStore } = await import('../src/lib/api-keys/key-store');
      // Reserve 10 units via redisKeyStore
      const res = await keyStore.reserveQuota(testUserId, 10);
      expect(res.allowed).toBe(true);

      // Verify that defaultKeyStore immediately sees the reservation
      const defaultUsage = await defaultKeyStore.getQuotaUsage(testUserId);
      expect(defaultUsage.usedToday).toBe(10);
      expect(defaultUsage.remaining).toBe(15);

      // Record additional 5 units via defaultKeyStore
      await defaultKeyStore.recordUsage(testUserId, 5);

      // redisKeyStore must immediately reflect the combined 15 units
      const redisUsage = await keyStore.getQuotaUsage(testUserId);
      expect(redisUsage.usedToday).toBe(15);
      expect(redisUsage.remaining).toBe(10);

      // A fresh instance loaded from disk must also reflect 15, not clobbered
      const diskStore = new KeyStore();
      const diskUsage = await diskStore.getQuotaUsage(testUserId);
      expect(diskUsage.usedToday).toBe(15);
    });

    it('refunds expired or rolled back reservations to original reservation date across UTC midnight', async () => {
      const res = await keyStore.reserveQuota(testUserId, 5);
      expect(res.allowed).toBe(true);

      const reservation = keyStore.getReservation(res.reservationId!);
      expect(reservation).toBeDefined();

      // Simulate reservation made on a different date (e.g. 2026-09-01)
      const fakePastDateKey = `${testUserId}:2026-09-01`;
      (keyStore as any).dailyUsage.set(fakePastDateKey, 5);
      reservation!.dateKey = fakePastDateKey;
      reservation!.expiresAt = Date.now() - 1000;

      // Clean expired reservations
      const cleaned = keyStore.cleanExpiredReservations();
      expect(cleaned).toBe(1);

      // The past date usage must be refunded to 0
      expect((keyStore as any).dailyUsage.get(fakePastDateKey)).toBe(0);
    });

    it('automatically cleans expired reservations on reserveQuota without requiring manual query', async () => {
      // Consume all 25 units
      const fullRes = await keyStore.reserveQuota(testUserId, 25);
      expect(fullRes.allowed).toBe(true);

      // Further reservation is blocked
      const blocked = await keyStore.reserveQuota(testUserId, 1);
      expect(blocked.allowed).toBe(false);

      // Simulate expiration
      const reservation = keyStore.getReservation(fullRes.reservationId!);
      expect(reservation).toBeDefined();
      reservation!.expiresAt = Date.now() - 1000;

      // Directly attempt reserveQuota without calling getActiveReservationsCount()
      const afterExpiry = await keyStore.reserveQuota(testUserId, 5);
      expect(afterExpiry.allowed).toBe(true);
      expect(afterExpiry.remaining).toBe(20);
    });
  });
});
