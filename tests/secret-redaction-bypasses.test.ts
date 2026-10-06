import { describe, it, expect } from 'vitest';
import {
  MAX_REDACTION_DEPTH,
  MAX_REDACTION_NODES,
  isSecretKey,
  redactForOutput,
  redactSecrets,
  redactText,
  redactUrl,
  scrubError,
} from '../src/lib/security/redact';

/**
 * One regression test per bypass found by review. Goldens are written by hand from the masking
 * contract: a secret key's value becomes "***", URLs keep scheme, host and path only.
 */

describe('userinfo with an at sign in the password', () => {
  it('splits userinfo at the last at sign in a URL', () => {
    expect(redactUrl('https://u:p@ss@host.example/x?sig=1')).toBe('https://***@host.example/x?***');
  });

  it('splits userinfo at the last at sign in text', () => {
    expect(redactText('fetch failed https://u:p@ss@host.example/x')).toBe('fetch failed https://***@host.example/x');
  });

  it('masks a password that contains a quote character', () => {
    expect(redactText('fetch failed https://u:pa"ss@h.example/x now')).toBe('fetch failed https://***@h.example/x now');
  });
});

describe('URL forms beyond the usual scheme', () => {
  it('masks a URL with a long scheme name', () => {
    expect(redactText('open someveryveryverylongscheme://u:p@host/x?sig=1 now')).toBe(
      'open someveryveryverylongscheme://***@host/x?*** now'
    );
  });

  it('masks a percent-encoded URL to the end of its token', () => {
    expect(redactText('GET https%3A%2F%2Fu%3Ap%40host%2Fx%3Fsig%3Dabc done')).toBe('GET https%3A%2F%2F*** done');
  });
});

describe('Authorization values of any scheme', () => {
  it('masks a token scheme to the end of the line', () => {
    expect(redactText('rejected\nAuthorization: Token abcdef123456\nnext')).toBe('rejected\nAuthorization: ***\nnext');
  });

  it('masks a multi-part AWS signature header to the end of the line', () => {
    const header =
      'Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20240101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=abcdef0123';
    expect(redactText(`${header}\nretrying`)).toBe('Authorization: ***\nretrying');
  });

  it('masks Proxy-Authorization with a digest scheme', () => {
    expect(redactText('proxy-authorization: Digest user="a", response="b"')).toBe('proxy-authorization: ***');
  });

  it('masks a quoted Authorization value in JSON', () => {
    expect(redactText('{"Authorization":"Token abcdef123456","ok":1}')).toBe('{"Authorization":"***","ok":1}');
  });

  it('masks short Bearer and Basic tokens', () => {
    expect(redactText('Authorization: Bearer abc')).toBe('Authorization: ***');
    expect(redactText('sent bearer abc today')).toBe('sent bearer *** today');
    expect(redactText('sent Basic dTpw today')).toBe('sent Basic *** today');
  });
});

describe('secret key names by token or suffix', () => {
  it('recognises prefixed, suffixed and header-style names', () => {
    for (const key of [
      'AWS_SECRET_ACCESS_KEY',
      'db_password',
      'DB_PASSWORD',
      'x-api-key',
      'x-auth-token',
      'x-goog-api-key',
      'X-Amz-Security-Token',
      'refreshToken',
      'myToken',
      'clientSecret',
      'mySecret',
      'userPassword',
      'accessKey',
      'awsAccessKey',
      'sessionToken',
      'sig',
      'pass',
      'auth',
      'requestHeaders',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('keeps harmless names that merely start with a secret word', () => {
    for (const key of ['tokenCount', 'maxTokens', 'tokenType', 'accessKeyId', 'bucket', 'status', 'hasWebhookSecret']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('masks pairs in text by those names', () => {
    expect(redactText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG\nbucket=reports')).toBe(
      'AWS_SECRET_ACCESS_KEY=***\nbucket=reports'
    );
    expect(redactText('DB_PASSWORD: hunter2')).toBe('DB_PASSWORD: ***');
    expect(redactText('X-Auth-Token: abcdef123')).toBe('X-Auth-Token: ***');
    expect(redactText('x-goog-api-key: AIzaSyDfake')).toBe('x-goog-api-key: ***');
    expect(redactText('tokenCount=42')).toBe('tokenCount=42');
  });

  it('masks values and keeps booleans in objects', () => {
    expect(redactSecrets({ AWS_SECRET_ACCESS_KEY: 'x', db_password: 'y', hasWebhookSecret: true, tokenCount: 3 })).toEqual({
      AWS_SECRET_ACCESS_KEY: '***',
      db_password: '***',
      hasWebhookSecret: true,
      tokenCount: 3,
    });
  });
});

describe('secret values containing separators', () => {
  it('masks to the end of the line when the value holds semicolons, commas or ampersands', () => {
    expect(redactText('password=a;b;c next')).toBe('password=***');
    expect(redactText('password=ab&cd next\nline2')).toBe('password=***\nline2');
    expect(redactText('password=ab,cd next')).toBe('password=***');
  });
});

describe('escaped JSON quotes', () => {
  it('masks a pair whose quotes are escaped once', () => {
    expect(redactText('body {\\"password\\":\\"hunter2\\"}')).toBe('body {\\"password\\":\\"***\\"}');
  });

  it('masks a pair inside a JSON string inside JSON', () => {
    const nested = JSON.stringify({ m: JSON.stringify({ password: 'hunter2', user: 'u' }) });
    expect(redactText(nested)).toBe(JSON.stringify({ m: JSON.stringify({ password: '***', user: 'u' }) }));
  });

  it('keeps an escaped quote inside a masked value from ending the mask early', () => {
    expect(redactText('{"password":"pa\\"ss","user":"u"}')).toBe('{"password":"***","user":"u"}');
  });
});

describe('header containers', () => {
  it('masks a headers object written as text', () => {
    expect(redactText('config headers: {"X-Custom":"secretvalue","a":{"b":"c"}} done')).toBe('config headers: *** done');
    expect(redactText("headers={ 'x-custom': 'secretvalue' } done")).toBe('headers=*** done');
  });

  it('masks requestHeaders-style maps by key', () => {
    expect(redactSecrets({ requestHeaders: { 'X-Whatever': 'v' }, extraHeaders: [['a', 'b']] })).toEqual({
      requestHeaders: '***',
      extraHeaders: '***',
    });
  });

  it('masks [name, value] pair arrays by the header name', () => {
    expect(
      redactSecrets({
        pairs: [
          ['X-Api-Token', 'abc'],
          ['Authorization', 'Bearer shorty'],
          ['X-Trace', 'keep'],
        ],
      })
    ).toEqual({
      pairs: [
        ['X-Api-Token', '***'],
        ['Authorization', '***'],
        ['X-Trace', 'keep'],
      ],
    });
  });

  it('masks inspect-style objects in text', () => {
    expect(redactText("{ Authorization: 'Bearer abc', 'x-api-key': 'k1', n: 1 }")).toBe(
      "{ Authorization: '***', 'x-api-key': '***', n: 1 }"
    );
  });
});

describe('scrubError reach', () => {
  it('masks the errors of an AggregateError', () => {
    const inner = new Error('agg https://u:p@h/x?sig=1 token=zzz1');
    const agg = new AggregateError([inner], 'agg');
    scrubError(agg);
    expect(inner.message).toBe('agg https://***@h/x?*** token=***');
  });

  it('masks own enumerable properties such as an HTTP client response', () => {
    const err = new Error('failed') as Error & { response?: unknown; code?: string };
    err.code = 'E_HTTP';
    err.response = {
      config: { headers: { Authorization: 'Bearer abcdefghij' }, url: 'https://u:p@h.example/?sig=1' },
      status: 403,
    };
    scrubError(err);
    expect(err.code).toBe('E_HTTP');
    expect(err.response).toEqual({ config: { headers: '***', url: 'https://***@h.example/?***' }, status: 403 });
  });

  it('follows nested errors in properties without looping on a cycle', () => {
    const a = new Error('a password=one') as Error & { peer?: Error };
    const b = new Error('b password=two') as Error & { peer?: Error };
    a.peer = b;
    b.peer = a;
    scrubError(a);
    expect([a.message, b.message]).toEqual(['a password=***', 'b password=***']);
  });
});

describe('redactForOutput never throws', () => {
  it('masks a subtree nested beyond the depth limit and keeps the rest', () => {
    let deep: Record<string, unknown> = { leaf: 'password=hunter2' };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 2; i++) deep = { child: deep };
    const out = redactForOutput({ keep: 'plain', deep }) as { keep: string; deep: unknown };
    expect(out.keep).toBe('plain');
    expect(JSON.stringify(out)).toContain('"***"');
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('masks what lies beyond the value limit', () => {
    const wide = Array.from({ length: MAX_REDACTION_NODES + 10 }, () => 'v');
    const out = redactForOutput(wide) as string[];
    expect(out.length).toBe(wide.length);
    expect(out[0]).toBe('v');
    expect(out.at(-1)).toBe('***');
  });

  it('masks a circular reference', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(redactForOutput(cyclic)).toEqual({ a: 1, self: '***' });
  });
});

describe('linear-time scanning of the new rules', () => {
  it('handles long runs of backslashes, quotes and unterminated values', () => {
    const LENGTH = 300_000;
    const LINEAR_TIME_BUDGET_MS = 5_000;
    const inputs = [
      '\\'.repeat(LENGTH),
      'password=\\"'.repeat(LENGTH / 10),
      'password="' + '\\"'.repeat(LENGTH / 2),
      'Authorization: '.repeat(LENGTH / 15),
      `https://${'a@'.repeat(LENGTH / 2)}`,
      'headers: {'.repeat(LENGTH / 10),
      `headers: ${'{'.repeat(LENGTH)}`,
      `x${'-a'.repeat(LENGTH / 2)}: 1`,
    ];
    const started = Date.now();
    for (const input of inputs) {
      expect(typeof redactText(input)).toBe('string');
    }
    expect(Date.now() - started).toBeLessThan(LINEAR_TIME_BUDGET_MS);
  });
});
