// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDashboardController } from '../src/components/dashboard/useDashboardController';
import { AccountQuotaPanel } from '../src/components/dashboard/AccountQuotaPanel';
import { integrationSnippets } from '../src/components/dashboard/IntegrationGuide';
import { testMessages } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  Link: 'a',
}));

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
