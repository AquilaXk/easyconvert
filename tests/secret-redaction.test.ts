import { describe, it, expect } from 'vitest';
import {
  MAX_ERROR_CAUSE_DEPTH,
  MAX_REDACTION_DEPTH,
  MAX_REDACTION_NODES,
  REDACTION_MASK,
  RedactionLimitError,
  SECRET_KEY_NAMES,
  isSecretKey,
  redactSecrets,
  redactText,
  redactUrl,
  scrubError,
} from '../src/lib/security/redact';

/**
 * Goldens are written by hand from the masking contract (secret keys become "***", URLs keep only
 * scheme, host and path with userinfo and query masked); nothing is derived from the module.
 */

describe('secret key set', () => {
  it('names the credential keys of every storage provider', () => {
    for (const name of [
      'secretaccesskey',
      'sessiontoken',
      'password',
      'apikey',
      'passphrase',
      'privatekey',
      'accountkey',
      'sastoken',
      'connectionstring',
      'bearertoken',
      'authorization',
      'headers',
      'webhooksecret',
      'serviceaccountkeyjson',
    ]) {
      expect(SECRET_KEY_NAMES.has(name)).toBe(true);
    }
  });

  it('ignores case, underscores and dashes in key names', () => {
    for (const key of ['secretAccessKey', 'secret_access_key', 'SECRET-ACCESS-KEY', 'X-Api-Key', 'api_key', 'Session_Token']) {
      expect(isSecretKey(key)).toBe(true);
    }
    for (const key of ['accessKeyId', 'bucket', 'filename', 'credentialRef', 'status']) {
      expect(isSecretKey(key)).toBe(false);
    }
  });
});

describe('redactUrl', () => {
  it('masks userinfo, query and fragment and keeps scheme, host, port and path', () => {
    expect(
      redactUrl('https://alice:hunter2@files.example.org:8443/a/b.csv?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIAEXAMPLE#frag')
    ).toBe('https://***@files.example.org:8443/a/b.csv?***#***');
  });

  it('leaves a clean URL untouched', () => {
    expect(redactUrl('https://files.example.org/a/b.csv')).toBe('https://files.example.org/a/b.csv');
  });

  it('masks a lone username as userinfo', () => {
    expect(redactUrl('sftp://deploy@host.example/data?x=1')).toBe('sftp://***@host.example/data?***');
  });

  it('masks the whole value when it is not a URL but still looks like a credential carrier', () => {
    expect(redactUrl('not a url?token=abc')).toBe(REDACTION_MASK);
  });
});

describe('redactText', () => {
  it('masks URLs embedded in error text and keeps the sentence', () => {
    expect(redactText('Failed to fetch https://u:p@h.example/x/y.bin?sig=abc123: HTTP 403')).toBe(
      'Failed to fetch https://***@h.example/x/y.bin?***: HTTP 403'
    );
  });

  it('masks several URLs in one line', () => {
    expect(redactText('copy http://a.example/p?k=1 to https://b.example/q?k=2.')).toBe(
      'copy http://a.example/p?*** to https://b.example/q?***.'
    );
  });

  it('masks bearer and basic credentials', () => {
    expect(redactText('upstream said: Authorization: Bearer abc.def-ghi_jkl123')).toContain('Authorization: ***');
    expect(redactText('upstream said: Authorization: Bearer abc.def-ghi_jkl123')).not.toContain('abc.def');
    expect(redactText('header Basic dXNlcjpwYXNzd29yZA== rejected')).toBe('header Basic *** rejected');
  });

  it('masks key=value and JSON pairs for secret keys only', () => {
    expect(redactText('password=hunter2\nbucket=reports')).toBe('password=***\nbucket=reports');
    expect(redactText('{"secretAccessKey":"wJalrXUtnFEMI/K7MDENG","bucket":"reports"}')).toBe(
      '{"secretAccessKey":"***","bucket":"reports"}'
    );
    expect(redactText("apiKey: 'k-12345', region: 'us-west-2'")).toBe("apiKey: '***', region: 'us-west-2'");
  });

  it('returns text without secrets unchanged', () => {
    const text = 'Node "n1" converted 2 artifact(s) to json in 14ms';
    expect(redactText(text)).toBe(text);
  });
});

describe('scrubError', () => {
  it('masks the message and stack of an error in place, and of its cause chain', () => {
    const root = new Error('root saw https://u:p@h.example/x?sig=1');
    const outer = new Error('outer: Authorization: Bearer abc.def-ghi_jkl123', { cause: root });
    const returned = scrubError(outer);
    expect(returned).toBe(outer);
    expect(outer.message).toBe('outer: Authorization: ***');
    expect(outer.stack).not.toContain('abc.def');
    expect(root.message).toBe('root saw https://***@h.example/x?***');
    expect(root.stack).toContain('root saw https://***@h.example/x?***');
  });

  it('returns values that are not errors unchanged', () => {
    expect(scrubError('password=hunter2')).toBe('password=hunter2');
    expect(scrubError(undefined)).toBeUndefined();
  });

  it('stops following a cause chain at the depth limit', () => {
    let error = new Error('https://u:p@h.example/leaf?sig=1');
    for (let i = 0; i < MAX_ERROR_CAUSE_DEPTH; i++) error = new Error(`wrap ${i}`, { cause: error });
    const leaf = (() => {
      let current: Error = error;
      while (current.cause instanceof Error) current = current.cause;
      return current;
    })();
    scrubError(error);
    expect(leaf.message).toBe('https://u:p@h.example/leaf?sig=1');
  });
});

describe('redactSecrets', () => {
  it('masks secret keys at every depth, including inside arrays', () => {
    const input = {
      jobId: 'g1',
      graph: {
        nodes: {
          out: { op: 'export.url', headers: { Authorization: 'Bearer top-secret' }, method: 'PUT' },
        },
      },
      targets: [
        { type: 's3', bucket: 'b', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI', sessionToken: 'FwoGZXIv' },
        { type: 'sftp', host: 'h', username: 'deploy', password: 'pw', privateKey: '-----BEGIN KEY-----' },
      ],
    };
    expect(redactSecrets(input)).toEqual({
      jobId: 'g1',
      graph: { nodes: { out: { op: 'export.url', headers: '***', method: 'PUT' } } },
      targets: [
        { type: 's3', bucket: 'b', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: '***', sessionToken: '***' },
        { type: 'sftp', host: 'h', username: 'deploy', password: '***', privateKey: '***' },
      ],
    });
  });

  it('masks URLs with userinfo or query inside string values', () => {
    expect(
      redactSecrets({ webhookUrl: 'https://svc:tok@hooks.example/h?sig=1', note: 'see https://x.example/a?b=c' })
    ).toEqual({ webhookUrl: 'https://***@hooks.example/h?***', note: 'see https://x.example/a?***' });
  });

  it('masks a secret key holding an object or array whole', () => {
    expect(redactSecrets({ password: { nested: 'x' }, apiKey: ['a', 'b'] })).toEqual({ password: '***', apiKey: '***' });
  });

  it('keeps absent secrets absent so presence is not disclosed by a mask', () => {
    expect(redactSecrets({ password: undefined, token: null })).toEqual({ password: undefined, token: null });
  });

  it('does not mutate its input and returns plain data', () => {
    const input = { a: { password: 'p' }, list: [{ apiKey: 'k' }] };
    const snapshot = JSON.stringify(input);
    const out = redactSecrets(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(out).not.toBe(input);
    expect(out.a).not.toBe(input.a);
  });

  it('redacts the message of an Error value', () => {
    const out = redactSecrets({ error: new Error('PUT https://h.example/o?X-Amz-Signature=abc failed') }) as {
      error: { name: string; message: string };
    };
    expect(out.error).toEqual({ name: 'Error', message: 'PUT https://h.example/o?*** failed' });
  });

  it('passes primitives through and masks top-level strings', () => {
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets('plain')).toBe('plain');
    expect(redactSecrets('https://u:p@h.example/x')).toBe('https://***@h.example/x');
  });

  it('throws a typed error beyond the depth limit instead of recursing without bound', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < MAX_REDACTION_DEPTH + 1; i++) deep = { child: deep };
    expect(() => redactSecrets(deep)).toThrow(RedactionLimitError);
  });

  it('throws a typed error beyond the node limit', () => {
    const wide = Array.from({ length: MAX_REDACTION_NODES + 1 }, (_, i) => i);
    expect(() => redactSecrets(wide)).toThrow(RedactionLimitError);
  });

  it('throws a typed error for a circular structure', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => redactSecrets(cyclic)).toThrow(RedactionLimitError);
  });
});
