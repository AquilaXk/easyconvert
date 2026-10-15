import { describe, it, expect } from 'vitest';
import { isSecretKey, redactForOutput, redactSecrets, redactText, redactUrl } from '../src/lib/security/redact';

/** Goldens are hand-written from the masking contract. */

describe('node ids are identifiers, not secret keys', () => {
  it('keeps the keys of a graph nodes map and masks secrets inside the nodes', () => {
    const graph = {
      nodes: {
        token: { op: 'convert', options: { password: 'p', note: 'ok' } },
        auth: { op: 'export.url', sealed: 'sealed:v1:abc' },
        password_zip: { op: 'archive.create', options: { password: 'zip-secret' } },
        sig: { op: 'import.url', headers: { 'X-Api-Key': 'k' } },
      },
    };
    expect(redactSecrets(graph)).toEqual({
      nodes: {
        token: { op: 'convert', options: { password: '***', note: 'ok' } },
        auth: { op: 'export.url', sealed: '***' },
        password_zip: { op: 'archive.create', options: { password: '***' } },
        sig: { op: 'import.url', headers: '***' },
      },
    });
  });

  it('keeps node-state ids in a webhook payload and in lenient output mode', () => {
    const payload = { jobId: 'g1', nodes: { token: { status: 'failed', error: 'password=hunter2' }, secret: { status: 'completed' } } };
    const expected = { jobId: 'g1', nodes: { token: { status: 'failed', error: 'password=***' }, secret: { status: 'completed' } } };
    expect(redactForOutput(payload)).toEqual(expected);
    expect(redactSecrets(payload)).toEqual(expected);
  });

  it('keeps the keys of a tasks map', () => {
    expect(redactSecrets({ tasks: { password: { op: 'convert' } } })).toEqual({ tasks: { password: { op: 'convert' } } });
  });

  it('still masks a secret key whose value is not a node entry', () => {
    expect(redactSecrets({ nodes: [{ token: 'x' }], other: { nodes: { token: 'plain-string-id-value' } } })).toEqual({
      nodes: [{ token: '***' }],
      other: { nodes: { token: 'plain-string-id-value' } },
    });
  });
});

describe('separators and layout', () => {
  it('masks a value after any amount of whitespace', () => {
    expect(redactText(`password:${' '.repeat(40)}hunter2`)).toBe(`password:${' '.repeat(40)}***`);
    expect(redactText(`password${' '.repeat(40)}=${' '.repeat(40)}hunter2`)).toBe(`password${' '.repeat(40)}=${' '.repeat(40)}***`);
  });

  it('masks a value that starts on the next line', () => {
    expect(redactText('password:\n  hunter2\nnext line')).toBe('password:\n  ***\nnext line');
    expect(redactText('token =\r\n\r\n abc123\r\nnext')).toBe('token =\r\n\r\n ***\r\nnext');
  });

  it('masks a quoted value on the next line', () => {
    expect(redactText('secret:\n  "two words"\nnext')).toBe('secret:\n  "***"\nnext');
  });

  it('runs an unquoted value to the end of the line, through quotes and spaces', () => {
    expect(redactText('password=hunter"2 more words\nnext')).toBe('password=***\nnext');
    expect(redactText("token=ab'c d e\nnext")).toBe('token=***\nnext');
  });
});

describe('plural and numbered key names', () => {
  it('recognises plural credential nouns and numbered forms', () => {
    for (const key of ['apiKeys', 'secrets', 'passwords', 'password1', 'password_2', 'apiKey3', 'passwordN', 'accessKeys', 'refreshTokens', 'secret2']) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('keeps counters and limits that merely share a word', () => {
    for (const key of ['tokens', 'maxTokens', 'tokenCount', 'sha256', 'secretsCount', 'keyCount']) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('masks them in text and objects', () => {
    expect(redactText('apiKeys: abc,def')).toBe('apiKeys: ***');
    expect(redactSecrets({ password2: 'a', secrets: ['b'], maxTokens: 10 })).toEqual({ password2: '***', secrets: '***', maxTokens: 10 });
  });
});

describe('JSON-escaped URLs', () => {
  it('masks userinfo and query of a URL with escaped slashes', () => {
    expect(redactText('{"u":"https:\\/\\/u:p@h.example\\/x?sig=1"}')).toBe('{"u":"https:\\/\\/***@h.example\\/x?***"}');
  });

  it('masks an escaped URL in plain text and in redactUrl', () => {
    expect(redactText('GET https:\\/\\/u:p@ss@h.example\\/x done')).toBe('GET https:\\/\\/***@h.example\\/x done');
    expect(redactUrl('https:\\/\\/u:p@h.example\\/x?sig=1')).toBe('https:\\/\\/***@h.example\\/x?***');
  });
});
