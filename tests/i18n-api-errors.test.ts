import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { POST as fetchUrl } from '../src/app/api/fetch-url/route';
import { useServerErrorMessage } from '../src/components/i18n/problems';
import { useAuthErrorMessage } from '../src/components/auth/auth-errors';
import { useUrlImportErrorMessage } from '../src/components/i18n/url-import-errors';
import { URL_IMPORT_ERROR_CODES } from '../src/lib/url-import-errors';
import type { TestLocale } from './helpers/intl';
import { renderDom, visibleText } from './helpers/rendered-dom';

/**
 * A refused API call reads in the page's language: typed problems by their type (with the server's facts after the
 * sentence), the link import's refusals by their stable `code`, and the sign-in refusals by their status. API callers
 * keep the English `error` text.
 */

const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;
const HANGUL = /[가-힣]/;

/** The text a hook's wording function gives, rendered under the page's message provider. */
function worded<A extends unknown[]>(useWording: () => (...args: A) => string, locale: TestLocale, ...args: A): string {
  function Wording() {
    return createElement('p', null, useWording()(...args));
  }
  return visibleText(renderDom(createElement(Wording), locale));
}

async function urlImportAnswer(url: unknown) {
  const res = await fetchUrl(
    new NextRequest('http://localhost:3000/api/fetch-url', { method: 'POST', body: JSON.stringify({ url }) })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('typed problems', () => {
  it('keeps the server detail after the translated sentence when it names facts', () => {
    const tooLarge = {
      type: 'https://api.easyconvert.io/problems/payload-too-large',
      detail: 'File size 2 GiB exceeds the 1 GiB limit for anonymous use.',
    };
    const korean = worded(useServerErrorMessage, 'ko', tooLarge, 'fallback');
    expect(korean).toMatch(HANGUL);
    expect(korean.endsWith(' File size 2 GiB exceeds the 1 GiB limit for anonymous use.')).toBe(true);
  });

  it('shows only the translated sentence when the detail restates it', () => {
    const unavailable = { type: 'https://api.easyconvert.io/problems/service-unavailable', detail: 'Service is down.' };
    expect(worded(useServerErrorMessage, 'ko', unavailable, 'fallback')).not.toMatch(ENGLISH_PHRASE);
  });
});

describe('link import refusals', () => {
  it('names each refusal with a stable code and keeps the English error for API callers', async () => {
    const answers = await Promise.all([undefined, 'not-a-valid-url', 'file:///etc/passwd', 'http://127.0.0.1/'].map(urlImportAnswer));
    expect(answers.map(({ status, body }) => [status, body.code])).toEqual([
      [400, 'url_required'],
      [400, 'invalid_url'],
      [400, 'unsupported_scheme'],
      [403, 'address_blocked'],
    ]);
    for (const { body } of answers) {
      expect(typeof body.error).toBe('string');
      expect(URL_IMPORT_ERROR_CODES).toContain(body.code);
    }
  });

  it('words every refusal code in Korean', () => {
    for (const code of URL_IMPORT_ERROR_CODES) {
      const korean = worded(useUrlImportErrorMessage, 'ko', { code, error: 'English text' }, 400);
      expect(korean, code).toMatch(HANGUL);
      expect(korean, code).not.toMatch(ENGLISH_PHRASE);
    }
  });

  it('shows the server text of an answer without a known code', () => {
    expect(worded(useUrlImportErrorMessage, 'ko', { error: 'Upstream said no.' }, 502)).toBe('Upstream said no.');
  });
});

describe('sign-in refusals', () => {
  it('words the untyped refusals of sign-in and sign-up by their status', () => {
    const cases: Array<['login' | 'register', number, string]> = [
      ['login', 401, 'Invalid email address or password.'],
      ['login', 400, 'Email and password are required strings.'],
      ['register', 409, 'An account with this email address already exists.'],
      ['register', 400, 'A valid email address is required.'],
    ];
    for (const [tab, status, error] of cases) {
      const korean = worded(useAuthErrorMessage, 'ko', tab, status, { success: false, error });
      expect(korean, `${tab} ${status}`).toMatch(HANGUL);
      expect(korean, `${tab} ${status}`).not.toMatch(ENGLISH_PHRASE);
    }
  });

  it('words a typed problem by its type and any other answer as the server wrote it', () => {
    const rateLimited = { type: 'https://api.easyconvert.io/problems/rate-limited', detail: 'Slow down.' };
    expect(worded(useAuthErrorMessage, 'ko', 'login', 429, rateLimited)).toMatch(HANGUL);
    expect(worded(useAuthErrorMessage, 'ko', 'login', 500, { error: 'Database offline.' })).toBe('Database offline.');
  });
});
