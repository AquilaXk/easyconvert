import crypto from 'node:crypto';
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER } from 'next/constants.js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as loginRoute } from '../src/app/api/auth/login/route';
import { GET as meRoute } from '../src/app/api/auth/me/route';
import { GET as googleCallbackRoute } from '../src/app/api/auth/google/callback/route';
import { GET as formatsRoute } from '../src/app/api/formats/route';
import { GET as healthConversionRoute } from '../src/app/api/health/conversion/route';
import { GET as queueStatsRoute } from '../src/app/api/queue/stats/route';
import { validateApiAccess } from '../src/lib/api-keys/guard';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { hashPassword } from '../src/lib/auth/crypto';
import {
  MAIL_DAILY_HARD_CAP,
  MAIL_DAILY_VERIFY_CAP,
  MAIL_DAILY_WARN,
  reserveMailSend,
  resetMailBudgetMemory,
} from '../src/lib/auth/mail-budget';
import { consumeOAuthSession, createOAuthSession, OAUTH_STATE_COOKIE_NAME } from '../src/lib/auth/oauth';
import { parseOperatorCliArgs } from '../src/lib/auth/operator-cli-args';
import { RedisUserStore, UPDATE_USER_LUA_SCRIPT, redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromRequest } from '../src/lib/auth/session';
import { HOST_SESSION_COOKIE_NAME } from '../src/lib/auth/session-cookie';
import { observeAuthMailBudgetEvent } from '../src/lib/metrics/instruments';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { cancelSingleQueueJob } from '../src/lib/queue/cancel-work';
import { graphScheduler } from '../src/lib/queue/graph';
import { sealGraph } from '../src/lib/queue/graph/node-jobs';
import type { JobGraph } from '../src/lib/queue/graph/types';
import { hasExternalProxyForwardingHeaders, isLocalOrBridgePeerIp, isLoopbackIp } from '../src/lib/security/loopback-only-guard';
import { main as cancelJobMain, MAX_USER_CANCEL_JOBS } from '../scripts/cancel-job';
import { main as confirmEmailMain } from '../scripts/confirm-account-email';
import { main as eraseAccountMain } from '../scripts/erase-account';
import { main as grantCreditsMain } from '../scripts/grant-test-credits';
import {
  applyAccountSuspension,
  main as setSuspensionMain,
  MAX_SUSPENSION_REASON_LENGTH,
  planAccountSuspension,
  sanitizeSuspensionReason,
} from '../scripts/set-account-suspension';
import { main as setTierMain } from '../scripts/set-account-tier';
import { allSamples, reading, resetMetrics } from './helpers/metrics-readings';

const createdUserIds: string[] = [];
let originalFetch: typeof fetch;

async function createTestAccount(options: {
  provider?: 'email' | 'google';
  password?: string;
  tier?: 'free' | 'paid';
  emailVerified?: boolean;
} = {}) {
  const email = `secops_${Date.now()}_${crypto.randomUUID()}@test.example`;
  const pwd = options.password ? await hashPassword(options.password) : undefined;
  const record = await redisUserStore.createUser({
    email,
    name: 'SecOps Tester',
    provider: options.provider ?? 'email',
    tier: options.tier ?? 'free',
    emailVerified: options.emailVerified ?? true,
    passwordHash: pwd?.hash,
    salt: pwd?.salt,
    passwordIterations: pwd?.iterations,
  });
  createdUserIds.push(record.id);
  return record;
}

describe('Track 1: loopback isolation, middleware hardening, config, and formats caching', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('detects loopback and Docker bridge socket peers while rejecting external proxy headers, HTTPS proxy proto, or multi-hop chains', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('[::1]')).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('203.0.113.5')).toBe(false);

    expect(isLocalOrBridgePeerIp('::ffff:172.18.0.1')).toBe(true);
    expect(isLocalOrBridgePeerIp('172.17.0.1')).toBe(true);
    expect(isLocalOrBridgePeerIp('172.32.0.1')).toBe(false);
    expect(isLocalOrBridgePeerIp('203.0.113.5')).toBe(false);

    expect(hasExternalProxyForwardingHeaders(new Headers())).toBe(false);
    expect(hasExternalProxyForwardingHeaders(new Headers({ 'x-real-ip': '127.0.0.1, [::1]' }))).toBe(false);
    // Next.js base-server.js synthesizes single socket peer x-forwarded-for + x-forwarded-proto: http on 127.0.0.1:8090:3000
    expect(
      hasExternalProxyForwardingHeaders(
        new Headers({ 'x-forwarded-for': '::ffff:172.18.0.1', 'x-forwarded-proto': 'http' })
      )
    ).toBe(false);
    expect(
      hasExternalProxyForwardingHeaders(
        new Headers({ 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1', 'x-forwarded-proto': 'https' })
      )
    ).toBe(true);
    expect(hasExternalProxyForwardingHeaders(new Headers({ 'x-forwarded-for': '127.0.0.1, ::ffff:172.18.0.1' }))).toBe(true);
    expect(hasExternalProxyForwardingHeaders(new Headers({ 'x-forwarded-for': '203.0.113.5' }))).toBe(true);
    expect(hasExternalProxyForwardingHeaders(new Headers({ 'x-real-ip': '127.0.0.1, 203.0.113.5' }))).toBe(true);
    expect(hasExternalProxyForwardingHeaders(new Headers({ 'x-real-ip': '' }))).toBe(true);

    for (const headerName of ['cf-connecting-ip', 'forwarded', 'true-client-ip', 'x-client-ip']) {
      expect(hasExternalProxyForwardingHeaders(new Headers({ [headerName]: '127.0.0.1' })), headerName).toBe(true);
    }
  });

  it('refuses /api/queue/stats and /api/health/conversion with 404 when forwarded in production while allowing direct loopback', async () => {
    vi.stubEnv('NODE_ENV', 'production');

    for (const headers of [
      { 'x-forwarded-for': '203.0.113.10' },
      { 'cf-connecting-ip': '203.0.113.10' },
      { forwarded: 'for=203.0.113.10' },
      { 'true-client-ip': '203.0.113.10' },
      { 'x-client-ip': '203.0.113.10' },
      { 'x-real-ip': '127.0.0.1, 203.0.113.10' },
    ] as Array<Record<string, string>>) {
      const statsRes = await queueStatsRoute(new NextRequest('https://convert.example.test/api/queue/stats', { headers }));
      expect(statsRes.status).toBe(404);

      const smokeRes = await healthConversionRoute(new NextRequest('https://convert.example.test/api/health/conversion', { headers }));
      expect(smokeRes.status).toBe(404);
    }

    const loopbackStatsRes = await queueStatsRoute(
      new NextRequest('http://127.0.0.1:8090/api/queue/stats', { headers: { 'x-real-ip': '127.0.0.1' } })
    );
    expect(loopbackStatsRes.status).toBe(200);
    expect((await loopbackStatsRes.json()).success).toBe(true);
  });

  it('charges malformed or oversized paddle-signature webhook headers to attacker IP bucket without draining webhook bucket', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 0, 1, 12, 0, 0));
    try {
      vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
      const { middleware } = await import('../src/middleware');

      const invalidSignatures = [
        'x',
        'ts=1;h1=00',
        'ts=abc;h1=' + 'a'.repeat(64),
        `ts=1;h1=${'g'.repeat(64)}`,
        `ts=1;h1=${'a'.repeat(64)};${'x'.repeat(500)}`,
      ];

      for (const sig of invalidSignatures) {
        const res = await middleware(
          new NextRequest('https://convert.example.test/api/billing/webhook', {
            method: 'POST',
            headers: { 'x-forwarded-for': '198.51.100.77', 'paddle-signature': sig },
          })
        );
        expect(res.status).not.toBe(429);
      }

      // Flood from attacker IP exhausts attacker IP bucket (60 tokens), never touching BILLING_WEBHOOK_BUCKET_KEY
      let limitedCount = 0;
      for (let i = 0; i < 80; i += 1) {
        const res = await middleware(
          new NextRequest('https://convert.example.test/api/billing/webhook', {
            method: 'POST',
            headers: { 'x-forwarded-for': '198.51.100.77', 'paddle-signature': 'x' },
          })
        );
        if (res.status === 429) limitedCount += 1;
      }
      expect(limitedCount).toBe(25);

      // Even from that same rate-limited attacker IP, a properly formatted webhook POST routes to BILLING_WEBHOOK_BUCKET_KEY and is not 429
      const validRes = await middleware(
        new NextRequest('https://convert.example.test/api/billing/webhook', {
          method: 'POST',
          headers: {
            'x-forwarded-for': '198.51.100.77',
            'paddle-signature': `ts=1700000000;h1=${'f'.repeat(64)}`,
          },
        })
      );
      expect(validRes.status).not.toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces Origin/Referer CSRF on cookie-only auth and billing mutation routes even when spoofed x-api-key or Bearer headers are attached', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    const { middleware } = await import('../src/middleware');

    const targets = ['/api/auth/logout', '/api/billing/checkout', '/api/billing/portal'];
    const spoofedHeadersList: Array<Record<string, string>> = [
      { 'x-api-key': 'ec_live_forged_key_0001' },
      { authorization: 'Bearer ec_live_forged_key_0001' },
    ];

    for (const pathname of targets) {
      for (const spoofed of spoofedHeadersList) {
        const missingOrigin = await middleware(
          new NextRequest(`https://convert.example.test${pathname}`, {
            method: 'POST',
            headers: {
              'x-forwarded-for': '198.51.100.21',
              cookie: `${HOST_SESSION_COOKIE_NAME}=session.jwt.value`,
              ...spoofed,
            },
          })
        );
        expect(missingOrigin.status, `${pathname} missing origin`).toBe(403);

        const crossOrigin = await middleware(
          new NextRequest(`https://convert.example.test${pathname}`, {
            method: 'POST',
            headers: {
              'x-forwarded-for': '198.51.100.22',
              cookie: `${HOST_SESSION_COOKIE_NAME}=session.jwt.value`,
              origin: 'https://evil.example.net',
              ...spoofed,
            },
          })
        );
        expect(crossOrigin.status, `${pathname} cross origin`).toBe(403);

        const sameOrigin = await middleware(
          new NextRequest(`https://convert.example.test${pathname}`, {
            method: 'POST',
            headers: {
              'x-forwarded-for': '198.51.100.23',
              cookie: `${HOST_SESSION_COOKIE_NAME}=session.jwt.value`,
              origin: 'https://convert.example.test',
              ...spoofed,
            },
          })
        );
        expect(sameOrigin.status, `${pathname} same origin`).not.toBe(403);
      }
    }
  });

  it('disables X-Powered-By header in next.config.mjs', async () => {
    const configMod = await import('../next.config.mjs');
    const prodConfig = await configMod.default(PHASE_PRODUCTION_SERVER);
    const devConfig = await configMod.default(PHASE_DEVELOPMENT_SERVER);
    expect(prodConfig.poweredByHeader).toBe(false);
    expect(devConfig.poweredByHeader).toBe(false);
  });

  it('sets public Cache-Control headers on 200 GET /api/formats responses only, never on 400 errors', async () => {
    const fullRes = await formatsRoute(new NextRequest('http://localhost:3000/api/formats'));
    expect(fullRes.status).toBe(200);
    expect(fullRes.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    const pairRes = await formatsRoute(new NextRequest('http://localhost:3000/api/formats?source=png&target=jpg'));
    expect(pairRes.status).toBe(200);
    expect(pairRes.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=600');

    const badRes = await formatsRoute(new NextRequest('http://localhost:3000/api/formats?source=doesnotexist'));
    expect(badRes.status).toBe(400);
    expect(badRes.headers.get('cache-control')).toBeNull();
  });
});

describe('Track 2: operator CLI arg parsing, account suspension, job cancellation, and mail budget metrics', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetMailBudgetMemory();
    resetMetrics();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const userId of createdUserIds.splice(0)) {
      await redisUserStore.deleteUser(userId);
    }
  });

  it('rejects missing or flag-like option values (e.g. --user --apply) with exit code 2 across all operator CLIs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(parseOperatorCliArgs(['--user', '--apply'], { valueFlags: ['--user'], booleanFlags: ['--apply'] }).ok).toBe(false);
    expect(parseOperatorCliArgs(['--user'], { valueFlags: ['--user'], booleanFlags: ['--apply'] }).ok).toBe(false);
    expect(parseOperatorCliArgs(['--user=--apply'], { valueFlags: ['--user'] }).ok).toBe(false);

    expect(await setTierMain(['--user', '--apply', '--tier', 'paid'])).toBe(2);
    expect(await grantCreditsMain(['--user', '--apply', '--credits', '100'])).toBe(2);
    expect(await confirmEmailMain(['--user', '--apply'])).toBe(2);
    expect(await confirmEmailMain(['--user', '--dry-run'])).toBe(2);
    expect(await eraseAccountMain(['--user', '--apply'])).toBe(2);
    expect(await setSuspensionMain(['--user', '--apply', '--suspend'])).toBe(2);
    expect(await setSuspensionMain(['--user', 'u1', '--suspend', '--unsuspend'])).toBe(2);
    expect(await setSuspensionMain(['--user', 'u1', '--unsuspend', '--reason', 'bad'])).toBe(2);
    expect(await cancelJobMain(['--job', '--apply'])).toBe(2);
    expect(await cancelJobMain(['--user', 'u1', '--job', 'j1'])).toBe(2);
  });

  it('sanitizes suspension reasons, enforces fail-closed suspension across sessions, API keys, password login, and Google OAuth, and cleanly unsuspends in Redis/Lua and memory', async () => {
    expect(sanitizeSuspensionReason(' \x00abuse\n\rreport\x7f  ')).toBe('abusereport');
    expect(sanitizeSuspensionReason('x'.repeat(MAX_SUSPENSION_REASON_LENGTH + 50))).toHaveLength(MAX_SUSPENSION_REASON_LENGTH);

    const passwordUser = await createTestAccount({ provider: 'email', password: 'CorrectPassword123!' });
    const jwtToken = createSessionToken(redisUserStore.sanitizeUser(passwordUser));
    const { secretKey } = await redisKeyStore.generateApiKey(passwordUser.id, 'suspend-key', { scopes: ['convert:read'] });

    // Dry run keeps account active
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await setSuspensionMain(['--user', passwordUser.email, '--suspend', '--reason', 'abuse\ntest'])).toBe(0);
    expect((await redisUserStore.findById(passwordUser.id))?.suspendedAt).toBeUndefined();

    // Apply suspension
    const plan = await planAccountSuspension(passwordUser.email, 'suspend', 'abuse\ntest');
    if ('refusal' in plan) throw new Error(plan.refusal);
    await applyAccountSuspension(plan, 1_700_000_000_000);

    const suspendedRecord = await redisUserStore.findById(passwordUser.id);
    expect(suspendedRecord?.suspendedAt).toBe(1_700_000_000_000);
    expect(suspendedRecord?.suspendedReason).toBe('abusetest');
    expect(suspendedRecord?.sessionVersion).toBeGreaterThanOrEqual(2);

    // 1) Existing JWT/cookie session is immediately rejected
    const sessionReq = new NextRequest('http://localhost:3000/api/auth/me', {
      headers: { cookie: `${HOST_SESSION_COOKIE_NAME}=${jwtToken}` },
    });
    expect(await getSessionFromRequest(sessionReq)).toBeNull();
    const meRes = await meRoute(sessionReq);
    expect(meRes.status).toBe(200);
    expect((await meRes.json()).authenticated).toBe(false);

    // 2) API key access returns 403 even with allowAnonymous: true
    const apiAuth = await validateApiAccess(
      new Request('http://localhost:3000/api/v1/formats', { headers: { 'x-api-key': secretKey } }),
      { allowAnonymous: true, requiredUnits: 0 }
    );
    expect(apiAuth.authorized).toBe(false);
    expect(apiAuth.status).toBe(403);
    expect(apiAuth.error).toBe('Forbidden: account is suspended.');

    // 3) Password login rejects with 403 and emits no session cookie/token (wrong password still 401)
    const badPwdRes = await loginRoute(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: passwordUser.email, password: 'WrongPassword123!' }),
      })
    );
    expect(badPwdRes.status).toBe(401);

    const loginRes = await loginRoute(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: passwordUser.email, password: 'CorrectPassword123!' }),
      })
    );
    expect(loginRes.status).toBe(403);
    expect(loginRes.headers.get('set-cookie')).toBeNull();
    const loginBody = await loginRes.json();
    expect(loginBody.token).toBeUndefined();

    // 4) Google OAuth callback rejects suspended account without issuing session cookie
    vi.stubEnv('GOOGLE_CLIENT_ID', 'test-google-client');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-google-secret');
    const googleUser = await createTestAccount({ provider: 'google' });
    const googlePlan = await planAccountSuspension(googleUser.id, 'suspend', 'tos violation');
    if ('refusal' in googlePlan) throw new Error(googlePlan.refusal);
    await applyAccountSuspension(googlePlan, 1_700_000_000_001);

    const oauthState = await createOAuthSession();
    const encodeSeg = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const idTok = `${encodeSeg({ alg: 'RS256' })}.${encodeSeg({
      iss: 'https://accounts.google.com',
      exp: Math.floor(Date.now() / 1000) + 3600,
      aud: 'test-google-client',
      sub: 'sub-google-suspended',
      nonce: oauthState.nonce,
    })}.sig`;
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, json: async () => ({ access_token: 'tok', id_token: idTok }) };
      }
      return {
        ok: true,
        json: async () => ({ sub: 'sub-google-suspended', email: googleUser.email, email_verified: true, name: 'G' }),
      };
    }) as typeof fetch;

    const cbRes = await googleCallbackRoute(
      new NextRequest(`http://localhost:3000/api/auth/google/callback?code=authcode&state=${oauthState.state}`, {
        headers: { cookie: `${OAUTH_STATE_COOKIE_NAME}=${oauthState.state}` },
      })
    );
    expect(cbRes.status).toBe(307);
    expect(cbRes.headers.get('location')).toContain('error=account_suspended');
    expect(cbRes.headers.get('set-cookie') ?? '').not.toContain('easyconvert_session=');
    // State was already consumed once
    expect(await consumeOAuthSession(oauthState.state)).toBeNull();

    // 5) Unsuspend cleanly deletes suspendedAt/suspendedReason (in-memory and Redis Lua null removal) and restores access
    const unsuspendPlan = await planAccountSuspension(passwordUser.id, 'unsuspend');
    if ('refusal' in unsuspendPlan) throw new Error(unsuspendPlan.refusal);
    await applyAccountSuspension(unsuspendPlan);

    const restoredRecord = await redisUserStore.findById(passwordUser.id);
    expect(restoredRecord?.suspendedAt).toBeUndefined();
    expect(restoredRecord?.suspendedReason).toBeUndefined();
    expect(Object.hasOwn(restoredRecord ?? {}, 'suspendedAt')).toBe(false);

    const restoredApi = await validateApiAccess(
      new Request('http://localhost:3000/api/v1/formats', { headers: { 'x-api-key': secretKey } }),
      { requiredUnits: 0 }
    );
    expect(restoredApi.authorized).toBe(true);

    const restoredLogin = await loginRoute(
      new NextRequest('http://localhost:3000/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: passwordUser.email, password: 'CorrectPassword123!' }),
      })
    );
    expect(restoredLogin.status).toBe(200);

    // Also prove Redis Lua cjson.null removal works for suspendedAt/suspendedReason
    const rawMap = new Map<string, string>();
    const seed = {
      id: 'usr_redis_suspend',
      email: 'redissuspend@test.example',
      name: 'Redis Suspend',
      tier: 'free',
      provider: 'email',
      suspendedAt: 1_700_000_000_000,
      suspendedReason: 'manual',
      createdAt: 1000,
      updatedAt: 1000,
    };
    rawMap.set(`r:{user}:${seed.id}`, JSON.stringify(seed));
    const luaRedis = {
      get: async (k: string) => rawMap.get(k) ?? null,
      eval: async (script: string, _numKeys: number, uKey: string, vKey: string, updJson: string, ts: string) => {
        if (script !== UPDATE_USER_LUA_SCRIPT) return null;
        const user = JSON.parse(rawMap.get(uKey)!) as Record<string, unknown>;
        const updates = JSON.parse(updJson) as Record<string, unknown>;
        for (const [k, v] of Object.entries(updates)) {
          if (v === null) delete user[k];
          else user[k] = v;
        }
        const v = rawMap.get(vKey);
        if (v && Number(user.sessionVersion ?? 1) < Number(v)) user.sessionVersion = Number(v);
        user.updatedAt = Number(ts);
        const enc = JSON.stringify(user);
        rawMap.set(uKey, enc);
        return enc;
      },
    };
    const rStore = new RedisUserStore({ redisClient: luaRedis as never, keyPrefix: 'r:{user}:' });
    const cleared = await rStore.updateUser(seed.id, { suspendedAt: null, suspendedReason: null });
    expect(cleared?.suspendedAt).toBeUndefined();
    expect(cleared?.suspendedReason).toBeUndefined();
    expect(Object.hasOwn(JSON.parse(rawMap.get(`r:{user}:${seed.id}`)!), 'suspendedAt')).toBe(false);
  });

  it('cancels single waiting jobs (refunding quota), running graphs, and capped <= 200 user jobs cleanly via cancel-job', async () => {
    const user = await createTestAccount({ tier: 'paid' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const reserved = await redisKeyStore.reserveQuota(user.id, 1);
    const queuedJobId = `job_${crypto.randomUUID()}`;
    const queuedJob = await conversionQueue.add('convert', {
      jobId: queuedJobId,
      userId: user.id,
      sourceFormat: 'png',
      targetFormat: 'jpg',
      originalFilename: 'a.png',
      fileSize: 64,
      options: {},
      storageKey: `inputs/${user.id}/a.png`,
      reservationId: reserved.reservationId,
    });

    // Completed job is left untouched and refused on direct --job target
    const doneJob = await conversionQueue.add('convert', {
      jobId: `job_${crypto.randomUUID()}`,
      userId: user.id,
      sourceFormat: 'png',
      targetFormat: 'jpg',
      originalFilename: 'done.png',
      fileSize: 64,
      options: {},
      storageKey: `inputs/${user.id}/done.png`,
    });
    doneJob.state = 'completed';

    // Dry run does not cancel
    expect(await cancelJobMain(['--job', queuedJob.id])).toBe(0);
    expect((await conversionQueue.getJob(queuedJob.id))?.state).toBe('waiting');

    // Apply cancels job & rolls back quota reservation
    expect(await cancelJobMain(['--job', queuedJob.id, '--apply'])).toBe(0);
    expect((await conversionQueue.getJob(queuedJob.id))?.state).toBe('cancelled');
    const afterUsage = await redisKeyStore.getQuotaUsage(user.id);
    expect(afterUsage.usedToday).toBe(0);

    // Create waiting jobs + running graph for --user batch cancel (testing >200 cap)
    const graphId = `graph_${crypto.randomUUID()}`;
    const testGraph: JobGraph = {
      failurePolicy: 'fail_fast',
      nodes: {
        n1: { op: 'import.upload', storageKey: `inputs/${user.id}/g.png` },
        n2: { op: 'convert', input: 'n1', targetFormat: 'webp' },
      },
    };
    await graphScheduler.initGraph(graphId, sealGraph(graphId, testGraph), { ownerUserId: user.id });

    const extraJobs: string[] = [];
    for (let i = 0; i < MAX_USER_CANCEL_JOBS + 5; i += 1) {
      const j = await conversionQueue.add('convert', {
        jobId: `job_batch_${i}_${crypto.randomUUID()}`,
        userId: user.id,
        sourceFormat: 'png',
        targetFormat: 'jpg',
        originalFilename: `batch_${i}.png`,
        fileSize: 64,
        options: {},
        storageKey: `inputs/${user.id}/batch_${i}.png`,
      });
      extraJobs.push(j.id);
    }

    // Apply one --user batch: cancels at most 200 items, leaving remainder intact and leaving completed job untouched
    expect(await cancelJobMain(['--user', user.email, '--apply'])).toBe(0);

    let cancelledBatch = 0;
    for (const id of extraJobs) {
      const st = (await conversionQueue.getJob(id))?.state;
      if (st === 'cancelled') cancelledBatch += 1;
    }
    const graphState = await graphScheduler.getGraphState(graphId);
    const totalCancelledNow = cancelledBatch + (graphState?.status === 'cancelled' ? 1 : 0);
    expect(totalCancelledNow).toBe(MAX_USER_CANCEL_JOBS);
    expect((await conversionQueue.getJob(doneJob.id))?.state).toBe('completed');

    // Second run cancels remaining items
    expect(await cancelJobMain(['--user', user.email, '--apply'])).toBe(0);
    const stillActive = [];
    for (const id of extraJobs) {
      const st = (await conversionQueue.getJob(id))?.state;
      if (st === 'waiting' || st === 'active' || st === 'delayed') stillActive.push(id);
    }
    expect(stillActive).toEqual([]);
    expect((await graphScheduler.getGraphState(graphId))?.status).toBe('cancelled');

    // Cleanup queued jobs from memory queues
    await conversionQueue.remove(queuedJob.id);
    await conversionQueue.remove(doneJob.id);
    for (const id of extraJobs) await conversionQueue.remove(id);
  });

  it('records easyconvert_auth_mail_budget_events_total once per warn/verify_cap/hard_cap threshold and enforces closed level labels', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    for (let i = 0; i < MAIL_DAILY_VERIFY_CAP + 3; i += 1) {
      await reserveMailSend('verify');
    }
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'warn' })).toBe(1);
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'verify_cap' })).toBe(1);
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'hard_cap' })).toBe(0);

    for (let i = MAIL_DAILY_VERIFY_CAP; i < MAIL_DAILY_HARD_CAP + 2; i += 1) {
      await reserveMailSend('reset');
    }
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'hard_cap' })).toBe(1);
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'warn' })).toBe(1);
    expect(MAIL_DAILY_WARN).toBeLessThan(MAIL_DAILY_VERIFY_CAP);

    observeAuthMailBudgetEvent('bogus_user_supplied' as never);
    const samples = await allSamples();
    const mailLevels = samples
      .filter((s) => s.metricName === 'easyconvert_auth_mail_budget_events_total')
      .map((s) => s.labels.level);
    expect(mailLevels).not.toContain('bogus_user_supplied');
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'warn' })).toBe(2);
  });

  it('awaits async cancellation listeners (e.g. delayed quota rollback) before cancelSingleQueueJob or cancel-job returns', async () => {
    const user = await createTestAccount({ tier: 'paid' });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    let rollbackCompleted = 0;
    const origRollback = redisKeyStore.rollbackQuota.bind(redisKeyStore);
    vi.spyOn(redisKeyStore, 'rollbackQuota').mockImplementation(async (reservationId: string) => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      const res = await origRollback(reservationId);
      rollbackCompleted += 1;
      return res;
    });

    const r1 = await redisKeyStore.reserveQuota(user.id, 1);
    const j1 = await conversionQueue.add('convert', {
      jobId: `job_${crypto.randomUUID()}`,
      userId: user.id,
      sourceFormat: 'png',
      targetFormat: 'jpg',
      originalFilename: 'delay1.png',
      fileSize: 64,
      options: {},
      storageKey: `inputs/${user.id}/delay1.png`,
      reservationId: r1.reservationId,
    });
    expect(await cancelSingleQueueJob(j1.id, 'test cancelSingleQueueJob delay')).toBe(true);
    expect(rollbackCompleted).toBe(1);

    const r2 = await redisKeyStore.reserveQuota(user.id, 1);
    const j2 = await conversionQueue.add('convert', {
      jobId: `job_${crypto.randomUUID()}`,
      userId: user.id,
      sourceFormat: 'png',
      targetFormat: 'jpg',
      originalFilename: 'delay2.png',
      fileSize: 64,
      options: {},
      storageKey: `inputs/${user.id}/delay2.png`,
      reservationId: r2.reservationId,
    });
    expect(await cancelJobMain(['--job', j2.id, '--apply'])).toBe(0);
    expect(rollbackCompleted).toBe(2);

    await conversionQueue.remove(j1.id);
    await conversionQueue.remove(j2.id);
  });

  it('records verify_cap even when a reset mail lands on verifyCap, and avoids double counting when verifyCap === hardCap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // 1. Default limits (350 / 400 / 480): 399 verify + 1 reset hits verifyCap=400 cleanly
    for (let i = 0; i < MAIL_DAILY_VERIFY_CAP - 1; i += 1) {
      await reserveMailSend('verify');
    }
    expect(await reserveMailSend('reset')).toBe(true);
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'verify_cap' })).toBe(1);
    expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'hard_cap' })).toBe(0);

    // 2. Equal verifyCap and hardCap records exactly once without duplicating events
    resetMailBudgetMemory();
    resetMetrics();
    vi.stubEnv('AUTH_MAIL_DAILY_WARN', '3');
    vi.stubEnv('AUTH_MAIL_DAILY_VERIFY_CAP', '5');
    vi.stubEnv('AUTH_MAIL_DAILY_HARD_CAP', '5');
    // Advance clock to a new UTC day so in-memory key is distinct from previous dayKey
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2030, 0, 2, 12, 0, 0));
      for (let i = 0; i < 5; i += 1) {
        await reserveMailSend('verify');
      }
      expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'warn' })).toBe(1);
      expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'verify_cap' })).toBe(1);
      expect(await reading('easyconvert_auth_mail_budget_events_total', { level: 'hard_cap' })).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
