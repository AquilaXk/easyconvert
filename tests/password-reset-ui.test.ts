// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const { AuthCredentialsForm, useServerFlag } = await import('../src/components/auth/AuthForms');
const { useFragmentToken } = await import('../src/components/auth/useFragmentToken');

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
  globalThis.history.replaceState(null, '', '/');
});

function render(locale: 'en' | 'ko', node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: node }));
}

const formProps = {
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  acceptedTerms: false,
  showPassword: false,
  isBusy: false,
  isSubmitting: false,
  onNameChange: () => undefined,
  onEmailChange: () => undefined,
  onPasswordChange: () => undefined,
  onConfirmPasswordChange: () => undefined,
  onAcceptedTermsChange: () => undefined,
  onTogglePassword: () => undefined,
  onSubmit: () => undefined,
} as const;

function answerStatus(enabled: boolean | 'down') {
  const fetchMock = vi.fn(async () => (enabled === 'down' ? new Response('{}', { status: 503 }) : Response.json({ success: true, enabled })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('the forgot-password link on the sign-in form', () => {
  it('shows the link to the request page when the server has mail, in the language of the page', async () => {
    const fetchMock = answerStatus(true);
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login' }));
    await vi.waitFor(() => expect(host.querySelector('a[href="/auth/forgot-password"]')?.textContent).toBe('Forgot password?'));
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/password-reset');
  });

  it('writes the link in Korean for a Korean page', async () => {
    answerStatus(true);
    render('ko', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login' }));
    await vi.waitFor(() => expect(host.querySelector('a[href="/auth/forgot-password"]')?.textContent).toBe('비밀번호가 기억나지 않아요'));
  });

  it.each([
    ['the server has no mail', false],
    ['the server cannot say', 'down' as const],
  ])('shows no link when %s', async (_label, enabled) => {
    const fetchMock = answerStatus(enabled);
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector('a[href="/auth/forgot-password"]')).toBeNull();
  });

  it('shows no link on the sign-up form', async () => {
    const fetchMock = answerStatus(true);
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'register' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector('a[href="/auth/forgot-password"]')).toBeNull();
  });
});

describe('the token of a mailed link', () => {
  function Probe() {
    const { ready, token } = useFragmentToken();
    return createElement('p', { id: 'probe' }, ready ? `ready:${token}` : 'waiting');
  }

  it('is read from the fragment and taken out of the address bar', async () => {
    const token = 'A'.repeat(43);
    globalThis.history.replaceState(null, '', `/auth/reset-password?x=1#token=${token}`);
    render('en', createElement(Probe));
    await vi.waitFor(() => expect(host.querySelector('#probe')?.textContent).toBe(`ready:${token}`));
    expect(globalThis.location.hash).toBe('');
    expect(globalThis.location.pathname + globalThis.location.search).toBe('/auth/reset-password?x=1');
  });

  it('is null when the address has none', async () => {
    globalThis.history.replaceState(null, '', '/auth/reset-password');
    render('en', createElement(Probe));
    await vi.waitFor(() => expect(host.querySelector('#probe')?.textContent).toBe('ready:null'));
  });
});

describe('the Google sign-in flag of the sign-in page', () => {
  function Probe() {
    return createElement('p', { id: 'probe' }, useServerFlag('/api/auth/google') ? 'on' : 'off');
  }

  it.each([
    ['the server has Google sign-in', true, 'on'],
    ['the server has none', false, 'off'],
    ['the server cannot say', 'down' as const, 'off'],
  ])('reads %s as %s', async (_label, enabled, shown) => {
    const fetchMock = answerStatus(enabled);
    render('en', createElement(Probe));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/auth/google'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.querySelector('#probe')?.textContent).toBe(shown);
  });
});
