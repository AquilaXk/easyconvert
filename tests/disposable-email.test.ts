import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DISPOSABLE_EMAIL_DOMAINS } from '../src/lib/auth/disposable-email-domains.generated';
import { isDisposableEmail } from '../src/lib/auth/disposable-email';

describe('the vendored list of disposable email domains', () => {
  it('is the list the module is built from, and names its source commit and licence', () => {
    const vendored = readFileSync('third_party/disposable-email-domains/disposable_email_blocklist.conf', 'utf8').split('\n').filter(Boolean);
    expect(DISPOSABLE_EMAIL_DOMAINS).toEqual(vendored);
    expect(() => execFileSync('node', ['scripts/refresh-disposable-email-domains.mjs', '--check'], { stdio: 'pipe' })).not.toThrow();
    expect(readFileSync('third_party/disposable-email-domains/SOURCE.md', 'utf8')).toMatch(/- Commit: `[0-9a-f]{40}`/);
    expect(readFileSync('third_party/disposable-email-domains/LICENSE.txt', 'utf8')).toContain('CC0 1.0 Universal');
  });
});

describe('isDisposableEmail', () => {
  it('refuses an address on a listed domain, whatever its case', () => {
    expect(isDisposableEmail('someone@0-mail.com')).toBe(true);
    expect(isDisposableEmail('Someone@0-MAIL.com')).toBe(true);
  });

  it('refuses a subdomain of a listed domain, and a listed domain that carries a public suffix', () => {
    expect(isDisposableEmail('someone@inbox.0-mail.com')).toBe(true);
    expect(isDisposableEmail('someone@a.b.0-mail.com')).toBe(true);
    expect(isDisposableEmail('someone@0-mailer.dynv6.net')).toBe(true);
    expect(isDisposableEmail('someone@sub.0-mailer.dynv6.net')).toBe(true);
  });

  it('accepts ordinary providers, and a domain that only ends like a listed one', () => {
    for (const address of ['a@gmail.com', 'a@naver.com', 'a@company.co.kr', 'a@not0-mail.com', 'a@0-mail.com.example.org', 'a@dynv6.net']) {
      expect(isDisposableEmail(address), address).toBe(false);
    }
  });

  it('treats a string without a domain as not disposable', () => {
    expect(isDisposableEmail('')).toBe(false);
    expect(isDisposableEmail('nodomain')).toBe(false);
  });
});
