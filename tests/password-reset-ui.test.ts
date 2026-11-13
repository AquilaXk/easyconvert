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

const { AuthCredentialsForm } = await import('../src/components/auth/AuthForms');
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
  step: 'start',
  code: '',
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  acceptedTerms: false,
  showPassword: false,
  isBusy: false,
  isSubmitting: false,
  onCodeChange: () => undefined,
  onResendCode: () => undefined,
  onBackToStart: () => undefined,
  onNameChange: () => undefined,
  onEmailChange: () => undefined,
  onPasswordChange: () => undefined,
  onConfirmPasswordChange: () => undefined,
  onAcceptedTermsChange: () => undefined,
  onTogglePassword: () => undefined,
  onSubmit: () => undefined,
} as const;

describe('the forgot-password link on the sign-in form', () => {
  // Whether the server can mail a reset link is read when the page is rendered and passed in, so the link is drawn with the form
  // and asks nothing of the server from the browser.
  const drawn = () => vi.waitFor(() => expect(host.querySelector('form')).not.toBeNull());

  it('shows the link to the request page when the server has mail, in the language of the page, without asking from the browser', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login', passwordResetEnabled: true }));
    await drawn();
    expect(host.querySelector('a[href="/auth/forgot-password"]')?.textContent).toBe('Forgot password?');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes the link in Korean for a Korean page', async () => {
    render('ko', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login', passwordResetEnabled: true }));
    await drawn();
    expect(host.querySelector('a[href="/auth/forgot-password"]')?.textContent).toBe('비밀번호 재설정');
  });

  it('shows no link when the server has no mail', async () => {
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login', passwordResetEnabled: false }));
    await drawn();
    expect(host.querySelector('a[href="/auth/forgot-password"]')).toBeNull();
  });

  it('shows no link on the sign-up form', async () => {
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'register', passwordResetEnabled: true }));
    await drawn();
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
