// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TERMS_VERSION } from '../src/lib/legal/documents';
import { testMessages } from './helpers/intl-messages';

/**
 * What the sign-up form, the sign-up with Google and the dashboard key form send about the terms: the version in force only
 * when the box is ticked, and no Google sign-up from the sign-up tab before it is.
 */

const ROUTER = { push: vi.fn(), refresh: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() };
vi.mock('../src/i18n/navigation', () => ({ useRouter: () => ROUTER }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useSearchParams: () => new URLSearchParams('tab=register'),
}));

const { useAuthController } = await import('../src/components/auth/useAuthController');
const { useApiKeysController } = await import('../src/components/dashboard/useDashboardController');

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Mounts `useController` under the English messages with `fetch` answering `answer`; the fetch mock and the live controller. */
async function mount<Controller>(useController: () => Controller, answer: (url: string) => Response) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => answer(url));
  vi.stubGlobal('fetch', fetchMock);
  let controller: Controller | undefined;
  function Probe() {
    controller = useController();
    return null;
  }
  root = createRoot(document.createElement('div'));
  root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(Probe) }));
  await vi.waitFor(() => expect(controller).toBeDefined());
  return { fetchMock, get current() { return controller!; } };
}

const submitEvent = () => ({ preventDefault: () => undefined }) as unknown as React.FormEvent;
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

describe('the sign-up form', () => {
  async function fillSignUp() {
    const auth = await mount(useAuthController, () => json({ success: false, code: 'terms_not_accepted' }, 400));
    auth.current.setEmail('reader@legal.test');
    auth.current.setPassword('LongEnough1');
    auth.current.setConfirmPassword('LongEnough1');
    await vi.waitFor(() => expect(auth.current.email).toBe('reader@legal.test'));
    return auth;
  }

  it('sends the terms version in force once the box is ticked, and none before', async () => {
    const auth = await fillSignUp();
    await auth.current.handleSubmit(submitEvent());
    expect(bodyOf(auth.fetchMock.mock.calls[0])).not.toHaveProperty('acceptedTermsVersion');

    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms).toBe(true));
    await auth.current.handleSubmit(submitEvent());
    expect(bodyOf(auth.fetchMock.mock.calls[1])).toMatchObject({ email: 'reader@legal.test', acceptedTermsVersion: TERMS_VERSION });
  });

  it('starts no sign-up with Google before the box is ticked, then asks for the URL with the version in force', async () => {
    const auth = await mount(useAuthController, () => json({ success: false }, 500));
    await auth.current.handleGoogleLogin();
    expect(auth.fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(auth.current.error).toBe('Accept the terms of service to create an account.'));

    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms).toBe(true));
    await auth.current.handleGoogleLogin();
    const asked = new URL(String(auth.fetchMock.mock.calls[0][0]), 'http://localhost');
    expect(asked.pathname).toBe('/api/auth/google/url');
    expect(asked.searchParams.get('acceptedTermsVersion')).toBe(TERMS_VERSION);
    expect(asked.searchParams.get('locale')).toBe('en');
  });

  it('words a refused Google start by its code, so an outdated page is told to reload', async () => {
    const auth = await mount(useAuthController, () => json({ success: false, code: 'terms_outdated' }, 400));
    auth.current.setAcceptedTerms(true);
    await vi.waitFor(() => expect(auth.current.acceptedTerms).toBe(true));
    await auth.current.handleGoogleLogin();
    await vi.waitFor(() =>
      expect(auth.current.error).toBe('The terms of service changed after this page was opened. Reload the page, then accept them again.')
    );
  });
});

describe('the dashboard key form', () => {
  it('sends the terms version in force with a new key once the box is ticked, and none before', async () => {
    const keys = await mount(
      () => useApiKeysController(true, () => undefined),
      (url) => json(url === '/api/keys' ? { success: true, keys: [] } : { success: true, usage: null })
    );
    await vi.waitFor(() => expect(keys.fetchMock).toHaveBeenCalledTimes(2));
    const posts = () => keys.fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST');

    keys.current.actions.onGenerateKey(submitEvent());
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).not.toHaveProperty('acceptedTermsVersion');

    keys.current.actions.onAcceptedTermsChange(true);
    await vi.waitFor(() => expect(keys.current.state.acceptedTerms).toBe(true));
    keys.current.actions.onGenerateKey(submitEvent());
    await vi.waitFor(() => expect(posts()).toHaveLength(2));
    expect(bodyOf(posts()[1])).toMatchObject({ acceptedTermsVersion: TERMS_VERSION });
  });
});
