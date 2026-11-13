// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { testMessages } from './helpers/intl-messages';

const ROUTER = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
  useRouter: () => ROUTER,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams('tab=register'),
}));

const { RegistrationSentPanel } = await import('../src/components/auth/AuthForms');
const { useAuthController } = await import('../src/components/auth/useAuthController');

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
});

function render(locale: 'en' | 'ko', node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: node }));
}

describe('the state after a sign-up', () => {
  it('says in one grey sentence, with the address in bold, where the link went, and offers the way to sign in, in Korean', async () => {
    const onSignIn = vi.fn();
    render('ko', createElement(RegistrationSentPanel, { email: 'reader@example.com', onSignIn }));
    await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull());
    expect(host.querySelector('strong')?.textContent).toBe('reader@example.com');
    expect(host.querySelector('p')?.textContent).toBe('reader@example.com 주소로 인증 링크를 보냈습니다. 메일의 링크를 열어 가입을 마치세요.');
    expect(host.textContent).toContain('메일이 오지 않으면 스팸 메일함을 확인하세요.');
    // The card's heading is the state (set by the page), and nothing here is an alert box.
    expect(host.querySelector('[role="alert"], output, [class*="bg-success"], [class*="bg-danger"]')).toBeNull();
    expect(host.querySelector('h1, h2')).toBeNull();
    host.querySelector('button')!.click();
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(host.querySelector('button')!.textContent).toBe('로그인하러 가기');
  });

  it('is worded in English too', async () => {
    render('en', createElement(RegistrationSentPanel, { email: 'reader@example.com', onSignIn: () => undefined }));
    await vi.waitFor(() => expect(host.querySelector('button')).not.toBeNull());
    expect(host.querySelector('p')?.textContent).toBe('We sent a verification link to reader@example.com. Open it to finish signing up.');
    expect(host.textContent).toContain('If it does not arrive, check your spam folder.');
    expect(host.querySelector('button')!.textContent).toBe('Go to sign in');
  });
});

describe('the controller after a sign-up', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const submit = () => ({ preventDefault: () => undefined }) as unknown as React.FormEvent;

  async function mount(answer: Response) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => answer.clone());
    vi.stubGlobal('fetch', fetchMock);
    let controller: ReturnType<typeof useAuthController> | undefined;
    function Probe() {
      controller = useAuthController();
      return null;
    }
    root = createRoot(document.createElement('div'));
    root.render(createElement(NextIntlClientProvider, { locale: 'ko', messages: testMessages('ko'), timeZone: 'UTC', children: createElement(Probe) }));
    await vi.waitFor(() => expect(controller).toBeDefined());
    return { fetchMock, get current() { return controller!; } };
  }

  async function fill(auth: Awaited<ReturnType<typeof mount>>) {
    auth.current.setEmail('reader@example.com');
    auth.current.setName('Reader');
    auth.current.setPassword('LongEnough1');
    auth.current.setConfirmPassword('LongEnough1');
    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms && auth.current.confirmPassword === 'LongEnough1').toBe(true));
  }

  it('posts the form once, starts no session and no redirect, and shows the mail state for the address', async () => {
    const auth = await mount(json({ success: true }, 202));
    await fill(auth);
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.registeredEmail).toBe('reader@example.com'));
    expect(auth.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = auth.fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/register');
    expect(JSON.parse(String(init?.body))).toEqual({
      email: 'reader@example.com',
      password: 'LongEnough1',
      name: 'Reader',
      locale: 'ko',
      acceptedTermsVersion: TERMS_VERSION,
    });
    expect(auth.current.error).toBeNull();
    expect(auth.current.password).toBe('');
    expect(ROUTER.push).not.toHaveBeenCalled();

    auth.current.handleTabSwitch('login');
    await vi.waitFor(() => expect(auth.current.registeredEmail).toBeNull());
  });

  it('words a refusal of the sign-up by its code and keeps the form', async () => {
    const auth = await mount(json({ success: false, code: 'disposable_email', error: 'x' }, 400));
    await fill(auth);
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.error).toBe('일회용 이메일 주소는 쓸 수 없습니다. 본인의 이메일 주소를 입력하세요.'));
    expect(auth.current.registeredEmail).toBeNull();
  });
});
