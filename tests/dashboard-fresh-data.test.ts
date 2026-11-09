// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { useDashboardController } from '../src/components/dashboard/useDashboardController';
import { AccountQuotaPanel } from '../src/components/dashboard/AccountQuotaPanel';
import { integrationSnippets } from '../src/components/dashboard/IntegrationGuide';
import { GET as listFiles } from '../src/app/api/account/files/route';
import { GET as listDlq } from '../src/app/api/webhooks/dlq/route';
import { GET as listKeys } from '../src/app/api/keys/route';
import { GET as keyUsage } from '../src/app/api/keys/usage/route';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { webhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';
import { createSessionToken } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';
import type { User } from '../src/lib/auth/types';
import { loadDashboardSnapshot } from '../src/lib/dashboard/snapshot';
import { testMessages } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/dashboard',
  getPathname: ({ href }: { href: string }) => href,
  Link: 'a',
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/dashboard',
  useSearchParams: () => new URLSearchParams(),
}));

const { default: DashboardPageView } = await import('../src/components/pages/DashboardPageView');

/** `content` under the English messages, with dates in `timeZone`. */
function inProvider(timeZone: string, content: ReactElement) {
  // eslint-disable-next-line react/no-children-prop -- the provider's typing requires `children` as a prop
  return createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone, children: content });
}

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const ANSWERS: Record<string, unknown> = {
  '/api/auth/me': { success: true, user: { id: 'u1', email: 'a@b.test', name: 'A', tier: 'free' } },
  '/api/keys': { success: true, keys: [] },
  '/api/keys/usage': { success: true, usage: { tier: 'free', dailyLimit: 10, usedToday: 0, remaining: 10, resetAt: 0 } },
  '/api/account/files': { files: [] },
  '/api/webhooks/dlq': { entries: [] },
};

async function mountDashboard() {
  const requests: string[] = [];
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify(ANSWERS[url] ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
  let controller: ReturnType<typeof useDashboardController> | undefined;
  function Probe() {
    controller = useDashboardController();
    return null;
  }
  root = createRoot(document.createElement('div'));
  root.render(inProvider('UTC', createElement(Probe)));
  await vi.waitFor(() => expect(requests.filter((url) => url === '/api/keys/usage')).toHaveLength(1));
  await vi.waitFor(() => expect(requests.filter((url) => url === '/api/account/files')).toHaveLength(1));
  const count = (url: string) => requests.filter((request) => request === url).length;
  return { count, get current() { return controller!; } };
}

describe('the dashboard reads again when the data may have changed', () => {
  it('reads the usage when its tab opens', async () => {
    const dashboard = await mountDashboard();
    dashboard.current.selectTab('usage');
    await vi.waitFor(() => expect(dashboard.count('/api/keys/usage')).toBe(2));
  });

  it('reads the files when their tab opens', async () => {
    const dashboard = await mountDashboard();
    dashboard.current.selectTab('files');
    await vi.waitFor(() => expect(dashboard.count('/api/account/files')).toBe(2));
  });

  it('reads the summary again when the page becomes visible', async () => {
    const dashboard = await mountDashboard();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(dashboard.count('/api/keys/usage')).toBe(2));
    expect(dashboard.count('/api/account/files')).toBe(2);
  });

  it('reads the summary again when the window gets focus', async () => {
    const dashboard = await mountDashboard();
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(dashboard.count('/api/keys/usage')).toBe(2));
  });
});

describe('the reset time of the usage tab', () => {
  const RESET_AT = Date.UTC(2026, 10, 9);
  const panel = (timeZone: string) =>
    renderToString(
      inProvider(
        timeZone,
        createElement(AccountQuotaPanel, {
          user: { id: 'u1', email: 'a@b.test', name: 'A', tier: 'free', provider: 'email', createdAt: 0 } as never,
          quota: { tier: 'free', dailyLimit: 10, usedToday: 0, remaining: 10, resetAt: RESET_AT },
          apiKeys: [],
        })
      )
    );

  it('shows 00:00 UTC as 9:00 AM in Seoul, with the zone named', () => {
    const html = panel('Asia/Seoul');
    expect(html).toMatch(/\b9:00\b[^<]*GMT\+9/);
    expect(html).not.toContain('12:00 AM');
  });

  it('shows the same moment as midnight in UTC', () => {
    expect(panel('UTC')).toMatch(/\b12:00 AM UTC\b/);
  });
});

describe('the code samples of the integration guide', () => {
  it('call the origin given, in every language', () => {
    const snippets = integrationSnippets('https://convert.example.org', 'KEY');
    for (const snippet of Object.values(snippets)) {
      expect(snippet).toMatch(/https:\/\/convert\.example\.org\/api\/v1\/convert\b/);
      expect(snippet).not.toContain('api.easyconvert.com');
    }
  });
});

const BASE_URL = 'http://localhost:3000';

async function createUser(label: string): Promise<User> {
  const email = `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}@ssr.test`;
  return userStore.sanitizeUser(await userStore.createUser({ email, name: label, tier: 'free' }));
}

const asUser = (user: User) => ({ headers: { Cookie: `easyconvert_session=${createSessionToken(user)}` } });

/** Gives `user` a key, a converted file and a failed webhook, all carrying `label` so another person's page can be searched for it. */
async function populate(user: User, label: string): Promise<void> {
  await redisKeyStore.generateApiKey(user.id, `${label}-key`, { scopes: ['convert:read'], webhookUrl: `https://hooks.example.com/${label}`, webhookSecret: `${label}-signing-secret` });
  await redisKeyStore.recordUserFile({
    userId: user.id,
    fileName: `${label}-report.pdf`,
    fromFormat: 'docx',
    toFormat: 'pdf',
    size: 1234,
    downloadUrl: `/api/storage/file/${label}`,
  });
  await webhookDispatcher.saveToDlq({
    id: `dlq_${label}`,
    originalDeliveryId: `wh_${label}`,
    targetUrl: `https://hooks.example.com/${label}`,
    event: 'job.failed',
    payload: { error: 'Timeout' },
    secret: `${label}-dlq-secret`,
    failedAt: Date.now(),
    retryCount: 3,
    status: 'failed',
    ownerUserId: user.id,
  });
}

/** The page as the server renders it, read back as a document. */
function renderDashboard(initial: Awaited<ReturnType<typeof loadDashboardSnapshot>> | undefined): Document {
  const html = renderToString(inProvider('UTC', createElement(DashboardPageView, { initial })));
  return new DOMParser().parseFromString(html, 'text/html');
}

const text = (node: Element | null | undefined) => node?.textContent?.replaceAll(/\s+/g, ' ').trim();

describe('the dashboard snapshot the server renders from', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('holds what the dashboard routes answer the same person', async () => {
    const user = await createUser('same');
    await populate(user, 'same');
    const snapshot = await loadDashboardSnapshot(user);
    const read = async (route: (req: NextRequest) => Promise<Response>, path: string) =>
      (await route(new NextRequest(`${BASE_URL}${path}`, asUser(user)))).json();

    const [keys, usage, files, dlq] = await Promise.all([
      read(listKeys, '/api/keys'),
      read(keyUsage, '/api/keys/usage'),
      read(listFiles, '/api/account/files'),
      read(listDlq, '/api/webhooks/dlq'),
    ]);
    const viaJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    expect(snapshot.keys).toHaveLength(1);
    expect(viaJson(snapshot.keys)).toEqual(keys.keys);
    expect(viaJson(snapshot.quota)).toEqual(usage.usage);
    expect(viaJson(snapshot.dlqEntries)).toEqual(dlq.entries);
    expect(snapshot.files).toHaveLength(1);
    // The countdown moves between the two reads; everything else is the same record.
    const withoutCountdown = (list: Array<{ remainingSeconds: number }>) => list.map(({ remainingSeconds: _s, ...rest }) => rest);
    expect(withoutCountdown(viaJson(snapshot.files!))).toEqual(withoutCountdown(files.files));
  });

  it('holds nothing of another person, and no key hash or signing secret', async () => {
    const mine = await createUser('mine');
    const theirs = await createUser('theirs');
    await populate(mine, 'mine');
    await populate(theirs, 'theirs');

    const serialized = JSON.stringify(await loadDashboardSnapshot(mine));
    expect(serialized).toContain('mine-key');
    expect(serialized).toContain('mine-report.pdf');
    expect(serialized).not.toContain('theirs');
    expect(serialized).not.toContain('keyHash');
    expect(serialized).not.toContain('mine-signing-secret');
    expect(serialized).not.toContain('mine-dlq-secret');
    expect(serialized).not.toContain(theirs.email);
  });

  it('leaves out a part that cannot be read and keeps the others', async () => {
    const user = await createUser('partial');
    await populate(user, 'partial');
    vi.spyOn(redisKeyStore, 'listApiKeys').mockRejectedValueOnce(new Error('store down'));
    const snapshot = await loadDashboardSnapshot(user);
    expect(snapshot).not.toHaveProperty('keys');
    expect(snapshot.quota).toBeDefined();
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.dlqEntries).toHaveLength(1);
  });
});

describe('the dashboard page rendered on the server', () => {
  it('has the person, the keys and the badges in its markup, and no loading state', async () => {
    const user = await createUser('Reader');
    await populate(user, 'first');
    const doc = renderDashboard(await loadDashboardSnapshot(user));

    expect(text(doc.querySelector('header'))).toContain('Reader');
    expect(doc.querySelectorAll('header a[href="/auth"]')).toHaveLength(0);
    expect(text(doc.querySelector('main h1'))).toBe('Developer Dashboard');
    expect(text(doc.querySelector('main'))?.includes(`Reader (${user.email})`)).toBe(true);
    const tabs = doc.querySelector('main [role=tablist]')!.querySelectorAll('[role=tab]');
    expect([...tabs].map(text)).toEqual(['Developer API Keys', 'My Converted Files1', 'Failed webhooks1', 'Usage & Rate Limits']);
    expect(doc.querySelectorAll('main tbody tr').length).toBe(1);
    expect(text(doc.querySelector('main tbody tr'))?.startsWith('first-key')).toBe(true);
    expect(doc.querySelectorAll('main output .animate-spin').length).toBe(0);
  });

  it('includes the email verification notice on the server when mail is configured and the address is not verified', async () => {
    vi.stubEnv('SMTP_HOST', 'smtp.example.test');
    vi.stubEnv('SMTP_USER', 'mailer');
    vi.stubEnv('SMTP_PASSWORD', 'secret');
    vi.stubEnv('APP_ORIGIN', 'https://convert.example.test');
    const unverifiedUser = await createUser('Unverified');
    const noticeCopy = testMessages('en').dashboard.emailNotice.text;

    const unverifiedDoc = renderDashboard(await loadDashboardSnapshot(unverifiedUser));
    expect(text(unverifiedDoc.querySelector('main'))).toContain(noticeCopy);

    const verifiedDoc = renderDashboard(await loadDashboardSnapshot({ ...unverifiedUser, emailVerified: true }));
    expect(text(verifiedDoc.querySelector('main'))).not.toContain(noticeCopy);
  });

  it('keeps the loading state for a page the server could not read the person for', () => {
    const doc = renderDashboard(undefined);
    expect(text(doc.querySelector('main output'))).toBe('Loading account session...');
    expect(doc.querySelectorAll('main [role=tab]').length).toBe(0);
  });
});
