import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMAIL_CODE_MAX_ATTEMPTS,
  EMAIL_CODE_TTL_SECONDS,
  isEmailCodeShape,
  issueEmailCode,
  resetEmailCodeMemory,
  verifyEmailCode,
} from '../src/lib/auth/email-code-store';

/** The six-digit code of a sign-up or a sign-in: one live code per address and purpose, ten minutes, a few guesses, once. */

const EMAIL = 'new.person@fixture.test';

function wrongCodeFor(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

beforeEach(() => {
  vi.stubEnv('KEY_HASH_PEPPER', 'fixture-pepper-0123456789abcdef0123456789abcdef');
  resetEmailCodeMemory();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('the code', () => {
  it('is six digits, zeros kept', async () => {
    const codes = new Set<string>();
    for (let index = 0; index < 300; index++) codes.add(await issueEmailCode('signup', `a${index}@fixture.test`));
    for (const code of codes) expect(isEmailCodeShape(code), code).toBe(true);
    expect(codes.size).toBeGreaterThan(250);
    vi.spyOn(crypto, 'randomInt').mockReturnValueOnce(42 as never);
    expect(await issueEmailCode('signup', 'zeros@fixture.test')).toBe('000042');
  });

  it('is recognised by shape: exactly six digits', () => {
    for (const good of ['000000', '123456', '999999']) expect(isEmailCodeShape(good)).toBe(true);
    for (const bad of ['12345', '1234567', '12345a', ' 123456', '123 456', '', 123456, null, undefined]) expect(isEmailCodeShape(bad), String(bad)).toBe(false);
  });
});

describe('verifying a code', () => {
  it('accepts the code it issued, once', async () => {
    const code = await issueEmailCode('signup', EMAIL);
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(true);
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(false);
  });

  it('reads the address without regard to case or surrounding space', async () => {
    const code = await issueEmailCode('signup', EMAIL);
    expect(await verifyEmailCode('signup', `  ${EMAIL.toUpperCase()} `, code)).toBe(true);
  });

  it('refuses a wrong code, an address that has none and a code of the other purpose', async () => {
    const code = await issueEmailCode('signup', EMAIL);
    expect(await verifyEmailCode('signup', EMAIL, wrongCodeFor(code))).toBe(false);
    expect(await verifyEmailCode('signup', 'other@fixture.test', code)).toBe(false);
    expect(await verifyEmailCode('login', EMAIL, code)).toBe(false);
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(true);
  });

  it(`burns the code after ${EMAIL_CODE_MAX_ATTEMPTS} wrong guesses, so the right one no longer works`, async () => {
    const code = await issueEmailCode('signup', EMAIL);
    for (let guess = 0; guess < EMAIL_CODE_MAX_ATTEMPTS; guess++) expect(await verifyEmailCode('signup', EMAIL, wrongCodeFor(code))).toBe(false);
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(false);
    // A new code is a fresh start.
    const next = await issueEmailCode('signup', EMAIL);
    expect(await verifyEmailCode('signup', EMAIL, next)).toBe(true);
  });

  it('counts a guess of a different shape too, so no input is a free probe', async () => {
    const code = await issueEmailCode('signup', EMAIL);
    for (let guess = 0; guess < EMAIL_CODE_MAX_ATTEMPTS; guess++) await verifyEmailCode('signup', EMAIL, 'abc');
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(false);
  });

  it(`expires after ${EMAIL_CODE_TTL_SECONDS} seconds`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T10:00:00Z'));
    const early = await issueEmailCode('signup', EMAIL);
    const late = await issueEmailCode('signup', 'other@fixture.test');
    vi.setSystemTime(new Date('2026-11-13T10:09:59Z'));
    expect(await verifyEmailCode('signup', EMAIL, early)).toBe(true);
    vi.setSystemTime(new Date('2026-11-13T10:10:00Z'));
    expect(await verifyEmailCode('signup', 'other@fixture.test', late)).toBe(false);
  });
});

describe('one live code per address', () => {
  it('replaces the earlier code when a new one is issued, and starts its guesses again', async () => {
    const first = await issueEmailCode('signup', EMAIL);
    for (let guess = 0; guess < EMAIL_CODE_MAX_ATTEMPTS - 1; guess++) await verifyEmailCode('signup', EMAIL, wrongCodeFor(first));
    let second = await issueEmailCode('signup', EMAIL);
    while (second === first) second = await issueEmailCode('signup', EMAIL);
    expect(await verifyEmailCode('signup', EMAIL, first)).toBe(false);
    expect(await verifyEmailCode('signup', EMAIL, second)).toBe(true);
  });

  it('keeps a sign-up code and a sign-in code of one address apart', async () => {
    const signup = await issueEmailCode('signup', EMAIL);
    const login = await issueEmailCode('login', EMAIL);
    expect(await verifyEmailCode('login', EMAIL, login)).toBe(true);
    expect(await verifyEmailCode('signup', EMAIL, signup)).toBe(true);
  });

  it('lets only one of two requests that hold the right code use it', async () => {
    const code = await issueEmailCode('signup', EMAIL);
    const answers = await Promise.all([verifyEmailCode('signup', EMAIL, code), verifyEmailCode('signup', EMAIL, code)]);
    expect(answers.filter(Boolean)).toHaveLength(1);
  });
});

describe('the pepper', () => {
  it('still accepts a code issued under the previous pepper during a rotation', async () => {
    vi.stubEnv('KEY_HASH_PEPPER', 'old-pepper-0123456789abcdef0123456789abcdef');
    const code = await issueEmailCode('signup', EMAIL);
    vi.stubEnv('KEY_HASH_PEPPER', 'new-pepper-0123456789abcdef0123456789abcdef');
    vi.stubEnv('KEY_HASH_PEPPER_PREVIOUS', 'old-pepper-0123456789abcdef0123456789abcdef');
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(true);
  });

  it('refuses a code issued under a pepper that is no longer current or previous', async () => {
    vi.stubEnv('KEY_HASH_PEPPER', 'old-pepper-0123456789abcdef0123456789abcdef');
    const code = await issueEmailCode('signup', EMAIL);
    vi.stubEnv('KEY_HASH_PEPPER', 'new-pepper-0123456789abcdef0123456789abcdef');
    expect(await verifyEmailCode('signup', EMAIL, code)).toBe(false);
  });
});
