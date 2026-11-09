import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, SESSION_COOKIE_NAME } from '../src/lib/auth/session';
import { userStore } from '../src/lib/auth/user-store';

let cookieValue: string | undefined;
const get = vi.fn((name: string) => (name === SESSION_COOKIE_NAME && cookieValue !== undefined ? { name, value: cookieValue } : undefined));
/** Next's `redirect` never returns: it throws to stop the render. */
const redirect = vi.fn((): never => {
  throw new Error('NEXT_REDIRECT');
});
vi.mock('next/headers', () => ({ cookies: async () => ({ get }) }));
vi.mock('../src/i18n/navigation', () => ({ redirect }));

const { readDashboardSession } = await import('../src/lib/auth/session-gate');

async function signedInUser() {
  const email = `gate_${Date.now()}_${Math.random().toString(16).slice(2)}@gate.test`;
  const user = userStore.sanitizeUser(await userStore.createUser({ email, name: 'Gate', tier: 'free' }));
  return { user, token: createSessionToken(user) };
}

describe('the dashboard gate reads the session on the server', () => {
  beforeEach(() => {
    cookieValue = undefined;
    get.mockClear();
    redirect.mockClear();
  });

  it('sends a visitor without a session cookie to the login page of the locale', async () => {
    await expect(readDashboardSession('ko')).rejects.toThrow('NEXT_REDIRECT');
    expect(get).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(redirect).toHaveBeenCalledWith({ href: '/auth', locale: 'ko' });
  });

  it('sends a visitor whose cookie stands for no session to the login page', async () => {
    cookieValue = 'not-a-token';
    await expect(readDashboardSession('en')).rejects.toThrow('NEXT_REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ href: '/auth', locale: 'en' });
  });

  it('sends a visitor whose session was revoked to the login page', async () => {
    const { user, token } = await signedInUser();
    await userStore.incrementSessionVersion(user.id);
    cookieValue = token;
    await expect(readDashboardSession('en')).rejects.toThrow('NEXT_REDIRECT');
  });

  it('returns the signed-in person the cookie stands for', async () => {
    const { user, token } = await signedInUser();
    cookieValue = token;
    await expect(readDashboardSession('ko')).resolves.toMatchObject({ id: user.id, email: user.email });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('renders without the person, and does not redirect, when the session store cannot answer', async () => {
    const { token } = await signedInUser();
    cookieValue = token;
    vi.spyOn(userStore, 'findById').mockRejectedValueOnce(new Error('store down'));
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    await expect(readDashboardSession('en')).resolves.toBeNull();
    expect(redirect).not.toHaveBeenCalled();
  });
});
