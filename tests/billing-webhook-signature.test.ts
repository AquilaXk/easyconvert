import { describe, expect, it } from 'vitest';
import { checkSignature, parseSignatureHeader } from '../src/lib/billing/webhook-signature';

/*
 * The vectors are those of PaddleHQ/paddle-node-sdk, src/__tests__/notifications/webhooks-validator.node.test.ts at commit
 * 4e6485ddf9a1547a7b3d111886080828a343d304 (Apache-2.0, Copyright 2024 Paddle.com Market Limited, SHA-256 of the file 0fb651d7...fc1b):
 * every hash was made with the secret `VALID_SECRET`, and the clock is 2023-11-01T00:00:00Z. See NOTICE and docs/licensing.md, 2.21.
 */
const NOW = Date.UTC(2023, 10, 1);

describe('checkSignature, with the vectors of the Node SDK', () => {
  it.each([
    ['Valid signature', '{"data": ["1", "2"]}', 'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9', 'VALID_SECRET', true],
    [
      'Valid signature with multiple hashes',
      '{"data": "value"}',
      'ts=1698796800;h1=28981e941fae76e53db32f3d2a83cb69db41476595e84e1970a1b5d98f62b261;h1=28981e941fae76e53db32f3d2a83cb69db41476595e84e1970a1b5d98f62b261;h2=RANDOM_HASH',
      'VALID_SECRET',
      true,
    ],
    ['Invalid secret', '{"data": ["1", "2"]}', 'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9', 'INVALID_VALID_SECRET', false],
    ['Invalid timestamp', '{"data": ["1", "2"]}', 'ts=9876;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9', 'VALID_SECRET', false],
    ['Invalid data - has more space', '{ "data": [ "1", "2" ]}', 'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9', 'VALID_SECRET', false],
    ['Invalid signature', '{"data": ["1", "2"]}', 'ts=1234;h1=invalid_signature', 'VALID_SECRET', false],
  ])('%s', (_, body, header, secret, expected) => {
    expect(checkSignature(secret, body, header, NOW).valid).toBe(expected);
  });

  it.each([
    ['Missing TS and H1', 'invalid_header'],
    ['Missing TS', 'h1=invalid_header'],
    ['Missing H1', 'ts=1234;h2=invalid_header'],
  ])('a header with %s is malformed', (_, header) => {
    expect(parseSignatureHeader(header)).toBeNull();
    expect(checkSignature('VALID_SECRET', '{"data": ["1", "2"]}', header, NOW)).toEqual({ valid: false, reason: 'malformed' });
  });

  it.each([
    ['Validates signature with correct TS within 5 seconds', Date.UTC(2023, 10, 1, 0, 0, 1), true],
    ['Validates signature at max allowed time at 5 seconds', Date.UTC(2023, 10, 1, 0, 0, 5), true],
    ['Will reject if current time is more than 5 seconds', Date.UTC(2023, 10, 1, 0, 0, 6), false],
    ['Will reject if current time is more than a few days', Date.UTC(2023, 10, 5), false],
    ['Will reject a timestamp more than 5 seconds ahead', Date.UTC(2023, 9, 31, 23, 59, 54), false],
  ])('%s', (_, now, expected) => {
    const header = 'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9';
    expect(checkSignature('VALID_SECRET', '{"data": ["1", "2"]}', header, now).valid).toBe(expected);
  });

  it('names the skew of a genuine signature outside the window, and only then', () => {
    const header = 'ts=1698796800;h1=a300428748dce5c70e4da19bffd60769591ea969c99dea3105d0ec9612cf43f9';
    expect(checkSignature('VALID_SECRET', '{"data": ["1", "2"]}', header, NOW + 12_000)).toEqual({ valid: false, reason: 'window', skewSeconds: 12 });
    expect(checkSignature('VALID_SECRET', '{"data": ["1", "2"]}', header, NOW - 30_000)).toEqual({ valid: false, reason: 'window', skewSeconds: -30 });
    expect(checkSignature('another_secret', '{"data": ["1", "2"]}', header, NOW + 12_000)).toEqual({ valid: false, reason: 'mismatch' });
  });
});

describe('parseSignatureHeader', () => {
  it('keeps every h1 in order and ignores keys it does not know', () => {
    expect(parseSignatureHeader('ts=1698796800;h1=aa;h2=bb;h1=cc')).toEqual({ timestamp: 1698796800, hashes: ['aa', 'cc'] });
  });

  it('refuses a timestamp that is not a plain number', () => {
    expect(parseSignatureHeader('ts=NaN;h1=aa')).toBeNull();
    expect(parseSignatureHeader('ts=;h1=aa')).toBeNull();
    expect(parseSignatureHeader('ts=-5;h1=aa')).toBeNull();
  });
});
