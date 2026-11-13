// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

const ROUTER = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
const SEARCH = vi.hoisted(() => ({ query: 'tab=register' }));
vi.mock('../src/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => createElement('a', { href, ...rest }, children),
  useRouter: () => ROUTER,
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams(SEARCH.query),
}));

const { AuthCredentialsForm, isEmailCodeInput } = await import('../src/components/auth/AuthForms');
const { useAuthController } = await import('../src/components/auth/useAuthController');

let root: Root | undefined;
let host: HTMLElement;

afterEach(() => {
  root?.unmount();
  root = undefined;
  SEARCH.query = 'tab=register';
  vi.unstubAllGlobals();
});

function render(locale: 'en' | 'ko', node: ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: node }));
}

const noop = () => undefined;
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
  passwordResetEnabled: true,
  onCodeChange: noop,
  onResendCode: noop,
  onBackToStart: noop,
  onNameChange: noop,
  onEmailChange: noop,
  onPasswordChange: noop,
  onConfirmPasswordChange: noop,
  onAcceptedTermsChange: noop,
  onTogglePassword: noop,
  onSubmit: noop,
} as const;

const ids = () => [...host.querySelectorAll('input')].map((input) => input.id);
const buttonTexts = () => [...host.querySelectorAll('button')].map((button) => button.textContent?.trim());
const drawn = () => vi.waitFor(() => expect(host.querySelector('form')).not.toBeNull());

describe('the steps of the form', () => {
  it('asks a sign-up first for the email and the terms only, and offers the code', async () => {
    render('ko', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'register', step: 'start' }));
    await drawn();
    expect(ids()).toEqual(['auth-email', 'auth-accept-terms']);
    expect(buttonTexts()).toEqual(['인증 코드 받기']);
  });

  it('asks a sign-up at the code step for the code, the name and the password, and offers a new code or another address', async () => {
    const onResendCode = vi.fn();
    const onBackToStart = vi.fn();
    render('ko', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'register', step: 'code', onResendCode, onBackToStart }));
    await drawn();
    expect(ids()).toEqual(['auth-code', 'auth-full-name', 'auth-password', 'auth-confirm-password']);
    expect(host.querySelector('label[for="auth-code"]')?.textContent).toBe('인증 코드');
    // The first button is the eye of the password field, which has an icon and a label for readers and no text.
    expect(buttonTexts()).toEqual(['', '계정 만들기', '코드 다시 받기', '이메일 주소 바꾸기']);
    const code = host.querySelector<HTMLInputElement>('#auth-code')!;
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(code.maxLength).toBe(6);
    [...host.querySelectorAll('button')].find((button) => button.textContent === '코드 다시 받기')!.click();
    [...host.querySelectorAll('button')].find((button) => button.textContent === '이메일 주소 바꾸기')!.click();
    expect(onResendCode).toHaveBeenCalledTimes(1);
    expect(onBackToStart).toHaveBeenCalledTimes(1);
  });

  it('asks the sign-in of an account that needs a code for the code alone', async () => {
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'login', step: 'code' }));
    await drawn();
    expect(ids()).toEqual(['auth-code']);
    expect(buttonTexts()).toEqual(['Confirm and Sign In', 'Send a new code', 'Back']);
    expect(host.querySelector('a[href="/auth/forgot-password"]')).toBeNull();
  });

  it('keeps only digits of what is typed or pasted into the code field', async () => {
    const onCodeChange = vi.fn();
    render('en', createElement(AuthCredentialsForm, { ...formProps, activeTab: 'register', step: 'code', onCodeChange }));
    await drawn();
    const code = host.querySelector<HTMLInputElement>('#auth-code')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, '12 34-56');
    code.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onCodeChange).toHaveBeenLastCalledWith('123456');
  });

  it('takes exactly six digits as a code', () => {
    expect(['000000', '123456'].every(isEmailCodeInput)).toBe(true);
    expect(['', '12345', '1234567', '12345a', ' 12345'].some(isEmailCodeInput)).toBe(false);
  });
});

describe('the controller through the steps', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const submit = () => ({ preventDefault: noop }) as unknown as React.FormEvent;
  const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

  async function mount(answer: (url: string, body: Record<string, unknown>) => Response) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => answer(url, JSON.parse(String(init?.body ?? '{}'))));
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

  it('moves a sign-up to the code step once the code is mailed, tells the address, and goes back to change it', async () => {
    const auth = await mount(() => json({ success: true }, 202));
    auth.current.setEmail('reader@fixture.test');
    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms).toBe(true));
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.step).toBe('code'));
    expect(auth.current.successMessage).toBe('reader@fixture.test 주소로 인증 코드를 보냈습니다. 10분 안에 입력하세요. 메일이 오지 않으면 스팸 메일함을 확인하세요.');

    await auth.current.resendCode();
    expect(auth.fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(auth.current.successMessage).toBe('새 인증 코드를 보냈습니다.'));

    auth.current.backToStart();
    await vi.waitFor(() => expect(auth.current.step).toBe('start'));
    expect(auth.current.code).toBe('');
  });

  it('words a refused code request by its code, and stays on the first step', async () => {
    const auth = await mount(() => json({ success: false, code: 'disposable_email', error: 'x' }, 400));
    auth.current.setEmail('someone@0-mail.com');
    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms).toBe(true));
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.error).toBe('일회용 이메일 주소는 쓸 수 없습니다. 본인의 이메일 주소를 입력하세요.'));
    expect(auth.current.step).toBe('start');
  });

  it('turns the 403 of an account of the old kind into the code step, then signs in with the code', async () => {
    SEARCH.query = '';
    const auth = await mount((url, body) => {
      if (url !== '/api/auth/login') return json({ success: false }, 500);
      if (body.code === '123456') return json({ success: true, user: { id: 'u', email: 'old@fixture.test', name: 'Old', tier: 'free', provider: 'email', createdAt: 0, updatedAt: 0, emailVerified: true } });
      return json({ success: false, code: 'email_verification_required', error: 'x' }, 403);
    });
    auth.current.setEmail('old@fixture.test');
    auth.current.setPassword('LongEnough1');
    await vi.waitFor(() => expect(auth.current.password).toBe('LongEnough1'));
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.step).toBe('code'));
    expect(auth.current.error).toBeNull();
    expect(auth.current.successMessage).toBe('이 계정의 이메일 주소를 아직 확인하지 않았습니다. old@fixture.test 주소로 인증 코드를 보냈습니다. 10분 안에 입력하세요.');

    auth.current.setCode('12');
    await vi.waitFor(() => expect(auth.current.code).toBe('12'));
    await auth.current.handleSubmit(submit());
    await vi.waitFor(() => expect(auth.current.error).toBe('인증 코드는 6자리 숫자입니다.'));
    expect(auth.fetchMock).toHaveBeenCalledTimes(1);

    auth.current.setCode('123456');
    await vi.waitFor(() => expect(auth.current.code).toBe('123456'));
    await auth.current.handleSubmit(submit());
    expect(bodyOf(auth.fetchMock.mock.calls[1])).toMatchObject({ email: 'old@fixture.test', password: 'LongEnough1', code: '123456' });
    await vi.waitFor(() => expect(auth.current.successMessage).toBe('로그인했습니다. 이동 중입니다.'));
  });
});
