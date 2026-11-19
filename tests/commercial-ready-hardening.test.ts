import crypto from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  setRequestLocale: () => undefined,
  getTranslations: async ({ locale, namespace }: { locale: 'en' | 'ko'; namespace: string }) =>
    (await import('./helpers/intl')).testTranslator(locale, namespace as never),
}));
import { POST as v1JobsPost } from '../src/app/api/v1/jobs/route';
import { POST as queueJobsPost } from '../src/app/api/queue/jobs/route';
import { POST as passwordChangePost } from '../src/app/api/auth/password-change/route';
import { DELETE as accountDelete } from '../src/app/api/auth/account/route';
import { GET as securityTxtGet } from '../src/app/.well-known/security.txt/route';
import { generateMetadata as converterMetadata } from '../src/app/[locale]/[slug]/page';
import { localizedPageMetadata } from '../src/i18n/page';
import { webApplicationJsonLd } from '../src/i18n/metadata';
import { hashPassword, verifyPassword } from '../src/lib/auth/crypto';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import { createSessionToken, getSessionFromToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import * as billingIndex from '../src/lib/billing';
import { PaddleBillingProvider } from '../src/lib/billing/paddle-provider';
import { subscriptionStore } from '../src/lib/billing/subscription-store';
import { conversionQueue } from '../src/lib/queue/conversion-queue';
import { storageProvider } from '../src/lib/storage';
import { persistCompletedServerQueue, restoreCompletedServerQueue } from '../src/lib/queue-session-persistence';
import { isInAppWebView, isMobileConstrainedBrowser, MOBILE_CONSTRAINED_MAX_BYTES } from '../src/lib/edge/mobile-browser-guard';
import { resolveConversionTier } from '../src/lib/edge/tier-router';
import type { ConversionQueueItem } from '../src/lib/types';

describe('Commercial operation hardening suite', () => {
  beforeEach(() => {
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('REDIS_HOST', '');
    vi.stubEnv('TRUSTED_PROXIES', 'none');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('1. Single-job inputBufferBase64 storage spill (zero inline file bytes in Redis)', () => {
    it('spills inline base64 payloads to storage on POST /api/v1/jobs and POST /api/queue/jobs', async () => {
      const email = `spill_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.local`;
      const user = await redisUserStore.createUser({ email, name: 'Spill User', tier: 'free', emailVerified: true });
      const { secretKey } = await redisKeyStore.generateApiKey(user.id, 'Spill Key', { scopes: ['convert:write', 'convert:read'] });
      const csvBytes = Buffer.from('name,score\nalice,98\nbob,95\n', 'utf8');
      const inputBufferBase64 = csvBytes.toString('base64');

      const v1Res = await v1JobsPost(
        new NextRequest('http://localhost/api/v1/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'scores.csv', targetFormat: 'json', inputBufferBase64 }),
        })
      );
      expect(v1Res.status).toBe(202);
      const v1Body = await v1Res.json();
      const v1Job = await conversionQueue.getJob(v1Body.jobId);
      expect(v1Job?.data.inputBufferBase64).toBeUndefined();
      expect(v1Job?.data.storageKey).toMatch(new RegExp(`^conversions/${user.id}/`));
      const storedV1 = await storageProvider.getObject(v1Job!.data.storageKey!);
      expect(storedV1?.buffer.equals(csvBytes)).toBe(true);

      const webRes = await queueJobsPost(
        new NextRequest('http://localhost/api/queue/jobs', {
          method: 'POST',
          headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'scores.csv', targetFormat: 'json', inputBufferBase64, fileSize: csvBytes.length }),
        })
      );
      expect(webRes.status).toBe(200);
      const webBody = await webRes.json();
      const webJob = await conversionQueue.getJob(webBody.jobId);
      expect(webJob?.data.inputBufferBase64).toBeUndefined();
      expect(webJob?.data.storageKey).toMatch(new RegExp(`^conversions/${user.id}/`));
      const storedWeb = await storageProvider.getObject(webJob!.data.storageKey!);
      expect(storedWeb?.buffer.equals(csvBytes)).toBe(true);
    });
  });

  describe('2. Self-serve password rotation and account erasure with Paddle subscription cancellation', () => {
    it('rotates password on POST /api/auth/password-change, revokes prior sessions, and mints a fresh cookie', async () => {
      const email = `pw_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.local`;
      const initial = await hashPassword('OldPass#2026');
      const user = await redisUserStore.createUser({
        email,
        name: 'Password User',
        tier: 'free',
        provider: 'email',
        passwordHash: initial.hash,
        salt: initial.salt,
        emailVerified: true,
      });
      const oldToken = createSessionToken(redisUserStore.sanitizeUser(user));

      const wrongRes = await passwordChangePost(
        new NextRequest('http://localhost/api/auth/password-change', {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${oldToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: 'WrongPassword!', newPassword: 'NewPass#2026_Valid' }),
        })
      );
      expect(wrongRes.status).toBe(401);

      const okRes = await passwordChangePost(
        new NextRequest('http://localhost/api/auth/password-change', {
          method: 'POST',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${oldToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: 'OldPass#2026', newPassword: 'NewPass#2026_Valid' }),
        })
      );
      expect(okRes.status).toBe(200);
      expect(okRes.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=`);

      // Old session token is invalidated via sessionVersion increment
      expect(await getSessionFromToken(oldToken)).toBeNull();
      const updated = await redisUserStore.findById(user.id);
      expect(await verifyPassword('NewPass#2026_Valid', updated!.passwordHash!, updated!.salt!)).toBe(true);
    });

    it('fails closed when active subscription cancellation fails, then cancels subscription and erases account on DELETE /api/auth/account', async () => {
      const email = `del_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.local`;
      const pw = await hashPassword('DeleteMe#2026');
      const user = await redisUserStore.createUser({
        email,
        name: 'Delete User',
        tier: 'paid',
        provider: 'email',
        passwordHash: pw.hash,
        salt: pw.salt,
        emailVerified: true,
      });
      await redisKeyStore.generateApiKey(user.id, 'Key to erase', { scopes: ['convert:read'] });
      await subscriptionStore.apply({
        eventId: `evt_${crypto.randomUUID()}`,
        eventAt: Date.now(),
        userId: user.id,
        subscription: {
          provider: 'paddle',
          providerCustomerId: 'ctm_test_1',
          providerSubscriptionId: 'sub_test_1',
          credits: 1000,
          status: 'active',
          currentPeriodEnd: Date.now() + 86_400_000,
        },
      });
      const token = createSessionToken(redisUserStore.sanitizeUser(user));

      // 1. Billing provider offline -> Fail-Closed 503, account stays intact
      vi.spyOn(billingIndex, 'getBillingProvider').mockReturnValueOnce(null);
      const offlineRes = await accountDelete(
        new NextRequest('http://localhost/api/auth/account', {
          method: 'DELETE',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'DeleteMe#2026', confirm: 'DELETE' }),
        })
      );
      expect(offlineRes.status).toBe(503);
      expect(await redisUserStore.findById(user.id)).not.toBeNull();

      // 2. Billing provider online -> cancels subscription immediately at Paddle, then erases user & keys
      const paddleCancel = vi.fn().mockResolvedValue(undefined);
      const provider = new PaddleBillingProvider(
        {
          apiKey: 'pdl_sdbx_apikey_1234567890',
          webhookSecret: 'pdl_ntfset_1234567890',
          clientToken: 'test_1234567890',
          environment: 'sandbox',
          packagePriceIds: { 500: 'pri_1', 1000: 'pri_2', 2500: 'pri_3', 5000: 'pri_4', 10000: 'pri_5' },
          subscriptionPriceIds: { 1000: 'pri_6', 2500: 'pri_7', 5000: 'pri_8', 10000: 'pri_9' },
        },
        { subscriptions: { cancel: paddleCancel } } as never
      );
      vi.spyOn(billingIndex, 'getBillingProvider').mockReturnValueOnce({ config: {} as never, provider });

      const delRes = await accountDelete(
        new NextRequest('http://localhost/api/auth/account', {
          method: 'DELETE',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: 'DeleteMe#2026', confirm: 'DELETE' }),
        })
      );
      expect(delRes.status).toBe(200);
      expect(paddleCancel).toHaveBeenCalledWith('sub_test_1', { effectiveFrom: 'immediately' });
      expect(await redisUserStore.findById(user.id)).toBeNull();
      expect(await redisKeyStore.listApiKeys(user.id)).toEqual([]);
      expect(await subscriptionStore.findByUser(user.id)).toBeNull();
    });

    it('erases a Google OAuth account after email confirmation without requiring a password', async () => {
      const email = `oauth_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@test.local`;
      const user = await redisUserStore.createUser({
        email,
        name: 'OAuth User',
        tier: 'free',
        provider: 'google',
        emailVerified: true,
      });
      const token = createSessionToken(redisUserStore.sanitizeUser(user));

      const mismatch = await accountDelete(
        new NextRequest('http://localhost/api/auth/account', {
          method: 'DELETE',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmEmail: 'wrong@test.local', confirm: 'DELETE' }),
        })
      );
      expect(mismatch.status).toBe(400);

      const ok = await accountDelete(
        new NextRequest('http://localhost/api/auth/account', {
          method: 'DELETE',
          headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmEmail: email.toUpperCase(), confirm: 'DELETE' }),
        })
      );
      expect(ok.status).toBe(200);
      expect(await redisUserStore.findById(user.id)).toBeNull();
    });
  });

  describe('3. Workbench sessionStorage completed server-result persistence', () => {
    it('persists only server-hosted completed results without options/secrets and expires stale entries', () => {
      const storageMap = new Map<string, string>();
      vi.stubGlobal('window', {});
      vi.stubGlobal('sessionStorage', {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, v); },
        removeItem: (k: string) => { storageMap.delete(k); },
      });

      const items: ConversionQueueItem[] = [
        {
          id: 'srv-1',
          file: new File(['x'], 'report.pdf'),
          name: 'report.pdf',
          size: 4096,
          sourceFormat: 'pdf',
          targetFormat: 'docx',
          status: 'completed',
          progress: 100,
          options: { password: 'top-secret-password' },
          resultUrl: '/api/storage/file/conversions%2F123%2Freport.docx',
          resultSize: 8192,
        },
        {
          id: 'blob-2',
          file: new File(['y'], 'local.png'),
          name: 'local.png',
          size: 512,
          sourceFormat: 'png',
          targetFormat: 'webp',
          status: 'completed',
          progress: 100,
          options: {},
          resultUrl: 'blob:https://convert.aquilaxk.site/abc-123',
          resultSize: 256,
        },
      ];

      const now = 1_700_000_000_000;
      persistCompletedServerQueue(items, 'home_scope', now);
      const raw = storageMap.get('easyconvert:completed-results:home_scope')!;
      expect(raw).not.toContain('top-secret-password');
      expect(raw).not.toContain('blob:');

      const restored = restoreCompletedServerQueue('home_scope', now + 60_000);
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({
        id: 'srv-1',
        name: 'report.pdf',
        resultUrl: '/api/storage/file/conversions%2F123%2Freport.docx',
        resultSize: 8192,
        options: {},
      });

      // Expired after 60 minutes (> 55 minute cap)
      expect(restoreCompletedServerQueue('home_scope', now + 60 * 60_000)).toEqual([]);
      vi.unstubAllGlobals();
    });
  });

  describe('4. OpenGraph, Twitter Card, JSON-LD, and RFC 9116 /.well-known/security.txt', () => {
    it('emits OpenGraph and Twitter cards on public pages, omits them on private pages, and serves RFC 9116 security.txt', async () => {
      const homeKo = await localizedPageMetadata(Promise.resolve({ locale: 'ko' }), 'home', '/');
      expect(homeKo.openGraph).toMatchObject({
        type: 'website',
        siteName: 'EasyConvert',
        locale: 'ko_KR',
        url: '/ko',
      });
      expect(homeKo.twitter).toMatchObject({ card: 'summary_large_image' });

      const dashMeta = await localizedPageMetadata(Promise.resolve({ locale: 'en' }), 'dashboard', '/dashboard');
      expect(dashMeta.openGraph).toBeUndefined();

      const pairMeta = await converterMetadata({ params: Promise.resolve({ locale: 'ko', slug: 'png-to-webp' }) });
      expect(pairMeta.openGraph).toMatchObject({ locale: 'ko_KR', url: '/ko/png-to-webp' });
      expect(pairMeta.twitter).toMatchObject({ card: 'summary_large_image' });

      const ld = webApplicationJsonLd({
        locale: 'ko',
        pathname: '/png-to-webp',
        name: 'PNG </script> WEBP',
        description: '안전한 변환',
      });
      expect(ld).not.toContain('</script>');
      expect(JSON.parse(ld)).toMatchObject({ '@type': 'WebApplication', inLanguage: 'ko' });

      const secRes = securityTxtGet();
      expect(secRes.status).toBe(200);
      expect(secRes.headers.get('content-type')).toContain('text/plain');
      const secBody = await secRes.text();
      expect(secBody).toContain('Contact: mailto:support@aquilaxk.site');
      expect(secBody).toContain('Expires: ');
      expect(secBody).toContain('Canonical: https://convert.aquilaxk.site/.well-known/security.txt');
    });
  });

  describe('5. Mobile Safari Jetsam guard and embedded In-App WebView detection', () => {
    it('detects messenger/social In-App WebViews and offloads > 16 MiB payloads on iOS Safari to L4 server tier', () => {
      const iphoneSafariUa =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
      const kakaoUa = `${iphoneSafariUa} KAKAOTALK 11.0.5`;
      const desktopChromeUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

      expect(isInAppWebView(kakaoUa)).toBe(true);
      expect(isInAppWebView(iphoneSafariUa)).toBe(false);
      expect(isMobileConstrainedBrowser(undefined, iphoneSafariUa)).toBe(true);
      expect(isMobileConstrainedBrowser(8, desktopChromeUa)).toBe(false);
      expect(isMobileConstrainedBrowser(undefined, desktopChromeUa)).toBe(false);

      vi.stubGlobal('navigator', { userAgent: iphoneSafariUa, hardwareConcurrency: 6 });
      const mobileTier = resolveConversionTier('png', 'webp', MOBILE_CONSTRAINED_MAX_BYTES + 1024, {}, {
        hardwareConcurrency: 6,
        deviceMemory: undefined,
        hasCanvas: true,
        hasWasmSimd: true,
      });
      expect(mobileTier.tier).toBe('L4');
      expect(mobileTier.isClientEdge).toBe(false);
      vi.unstubAllGlobals();
    });
  });
});
