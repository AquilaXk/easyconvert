// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

vi.mock('../src/components/Header', () => ({ default: () => null }));
vi.mock('../src/components/Footer', () => ({ default: () => null }));
vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { default: VerifyEmailPageView } = await import('../src/components/pages/VerifyEmailPageView');

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
  globalThis.history.replaceState(null, '', '/');
});

function render(locale: 'en' | 'ko') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement(VerifyEmailPageView) }));
}

const TOKEN = 'A'.repeat(43);
const ALERT_BOXES = '[class*="bg-success"], [class*="bg-danger"], output';

describe('the page the verification link opens', () => {
  it('asks first, and its heading becomes the state once the address is confirmed, with a plain line and the dashboard link and no alert box', async () => {
    globalThis.history.replaceState(null, '', `/auth/verify-email#token=${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render('ko');
    await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull());
    expect(host.querySelector('h1')?.textContent).toBe('이메일 주소 확인');
    host.querySelector('button')!.click();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('이메일 주소를 확인했습니다'));
    expect(host.textContent).toContain('이제 무료 크레딧을 쓸 수 있습니다.');
    expect(host.querySelector('button')).toBeNull();
    expect(host.querySelector(ALERT_BOXES)).toBeNull();
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/dashboard');
  });

  it('is worded in English', async () => {
    globalThis.history.replaceState(null, '', `/auth/verify-email#token=${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    render('en');
    await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull());
    host.querySelector('button')!.click();
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Email address confirmed'));
    expect(host.textContent).toContain('You can now use your free credits.');
  });

  it('says a refusal and a missing token as a plain line of text, not in a box', async () => {
    globalThis.history.replaceState(null, '', `/auth/verify-email#token=${TOKEN}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: false, code: 'invalid_token' }), { status: 400, headers: { 'Content-Type': 'application/json' } })));
    render('en');
    await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull());
    host.querySelector('button')!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This link is not valid or has expired. Ask for a new one.');
    expect(host.querySelector(ALERT_BOXES)).toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe('Confirm your email address');
  });
});
