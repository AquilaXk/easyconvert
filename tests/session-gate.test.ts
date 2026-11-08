import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE_NAME } from '../src/lib/auth/session';

const has = vi.fn();
const redirect = vi.fn();
vi.mock('next/headers', () => ({ cookies: async () => ({ has }) }));
vi.mock('../src/i18n/navigation', () => ({ redirect }));

const { redirectWithoutSessionCookie } = await import('../src/lib/auth/session-gate');

describe('the dashboard gate of a visitor without a session cookie', () => {
  beforeEach(() => {
    has.mockReset();
    redirect.mockReset();
  });

  it('sends the visitor to the login page of the locale', async () => {
    has.mockReturnValue(false);
    await redirectWithoutSessionCookie('ko');
    expect(has).toHaveBeenCalledWith(SESSION_COOKIE_NAME);
    expect(redirect).toHaveBeenCalledWith({ href: '/auth', locale: 'ko' });
  });

  it('lets a visitor with the cookie through to the page', async () => {
    has.mockReturnValue(true);
    await redirectWithoutSessionCookie('ko');
    expect(redirect).not.toHaveBeenCalled();
  });
});
