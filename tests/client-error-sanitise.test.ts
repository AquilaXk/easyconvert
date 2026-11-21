import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CHARS, MAX_STACK_FRAMES } from '../src/lib/client-errors/report';
import { browserFamilyOf, sanitiseClientError } from '../src/lib/client-errors/sanitise';

/** The line the server logs for a crash the browser reports: only what the limits of entry 384 let through. */

const CHROME_STACK = [
  'TypeError: Cannot read properties of undefined (reading \'map\')',
  '    at renderQueue (https://convert.example.test/_next/static/chunks/app/page-1a2b3c.js:1:2345)',
  '    at https://convert.example.test/_next/static/chunks/main-4d5e6f.js:7:89',
  '    at Object.run (chrome-extension://abcdefghijklmnop/content.js:1:1)',
].join('\n');

const REPORT = { kind: 'error', name: 'TypeError', message: "Cannot read properties of undefined (reading 'map')", stack: CHROME_STACK, path: '/ko/pdf-to-jpg' };
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function lineOf(overrides: Record<string, unknown> = {}, userAgent: string | null = CHROME_UA) {
  const line = sanitiseClientError({ ...REPORT, ...overrides }, userAgent);
  if (!line) throw new Error('the report was refused');
  return line;
}

describe('the shape of a report', () => {
  it('keeps the fields of a report and names the browser family', () => {
    expect(lineOf({ release: 'a'.repeat(40), digest: 'abc123' })).toEqual({
      kind: 'error',
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'map')",
      frames: [
        'renderQueue /_next/static/chunks/app/page-1a2b3c.js:1:2345',
        '? /_next/static/chunks/main-4d5e6f.js:7:89',
        'Object.run [other]:1:1',
      ],
      digest: 'abc123',
      path: '/ko/pdf-to-jpg',
      release: 'a'.repeat(40),
      browser: 'chrome',
    });
  });

  it.each([
    ['a body that is not an object', 'oops'],
    ['an array', [REPORT]],
    ['null', null],
    ['an unknown kind', { ...REPORT, kind: 'console' }],
    ['a message that is not text', { ...REPORT, message: { toString: 'x' } }],
    ['a missing message', { kind: 'error', name: 'Error', path: '/' }],
    ['a path that is not a path', { ...REPORT, path: 'https://evil.example/' }],
    ['a path of another host', { ...REPORT, path: '//evil.example/x' }],
    ['a missing path', { kind: 'error', name: 'Error', message: 'x' }],
  ])('refuses %s', (_label, body) => {
    expect(sanitiseClientError(body, CHROME_UA)).toBeNull();
  });

  it('drops the fields it does not know', () => {
    const line = lineOf({ email: 'a@b.test', token: 'secret', userAgent: 'x', localStorage: '{"a":1}' });
    expect(Object.keys(line).sort()).toEqual(['browser', 'frames', 'kind', 'message', 'name', 'path']);
  });

  it('names an unusual error name Error, and drops a digest or release that is not one', () => {
    const line = lineOf({ name: 'Not a name <script>', digest: 'x y', release: 'main' });
    expect(line.name).toBe('Error');
    expect(line.digest).toBeUndefined();
    expect(line.release).toBeUndefined();
  });
});

describe('the page path', () => {
  it.each([
    ['/ko/pdf-to-jpg?token=abc#frag', '/ko/pdf-to-jpg'],
    ['/dashboard?email=a@b.test', '/dashboard'],
    ['/', '/'],
    ['/convert/0123456789abcdef0123456789abcdef', '/convert/:x'],
    ['/ko/Some%20File.pdf', '/ko/:x'],
    ['/a/b/c/d/e/f/g/h/i/j', '/a/b/c/d/e/f/g/h'],
  ])('reads %s as %s', (path, expected) => {
    expect(lineOf({ path }).path).toBe(expected);
  });
});

describe('what the message may hold', () => {
  it.each([
    ['a link with a query', 'Failed to fetch https://convert.example.test/api/x?token=abc123&u=me', 'Failed to fetch [url]'],
    ['an address', 'Could not mail jane.doe@example.com now', 'Could not mail [email] now'],
    ['a file name of a format', 'Cannot decode holiday-photos_2025.heic at byte 5', 'Cannot decode [file] at byte 5'],
    ['a quoted name with a space', 'Cannot open "Tax return 2025.xlsx"', 'Cannot open "[text]"'],
    ['a quoted property', "Cannot read properties of null (reading 'name')", "Cannot read properties of null (reading 'name')"],
    ['a token', 'Bad job 8f14e45fceea167a5a36dedd4bea2543 here', 'Bad job [token] here'],
    ['a bearer credential', 'Request failed: Authorization: Bearer abcdefghijklmnop', 'Request failed: Authorization: ***'],
    ['a long number', 'Account 1234567890123 failed', 'Account [n] failed'],
    ['a long identifier without digits', 'useConversionQueueController is not a function', 'useConversionQueueController is not a function'],
    ['line breaks and tabs', 'one\n\ttwo\r\nthree', 'one two three'],
  ])('cuts %s', (_label, message, expected) => {
    expect(lineOf({ message }).message).toBe(expected);
  });

  it('cuts a message to its limit and reads no more than a bounded text', () => {
    const line = lineOf({ message: 'word '.repeat(100_000) });
    expect(line.message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });
});

describe('the stack', () => {
  it('keeps the frames of this site by script path and position, and nothing of any other script', () => {
    const { frames } = lineOf();
    expect(frames).toHaveLength(3);
    expect(frames.join('\n')).not.toMatch(/https?:|chrome-extension|convert\.example\.test|abcdefghijklmnop/);
  });

  it('reads the frames of Firefox and Safari', () => {
    const stack = 'renderQueue@https://convert.example.test/_next/static/chunks/page.js:10:20\n@https://convert.example.test/_next/static/chunks/main.js:3:4\nnative@[native code]';
    expect(lineOf({ stack }).frames).toEqual(['renderQueue /_next/static/chunks/page.js:10:20', '? /_next/static/chunks/main.js:3:4']);
  });

  it('drops the first line of a Chrome stack, which repeats the message', () => {
    expect(lineOf({ message: 'x', stack: 'Error: secret-name.pdf\n    at f (https://h.test/_next/static/a.js:1:2)' }).frames).toEqual(['f /_next/static/a.js:1:2']);
  });

  it('keeps at most the first frames, and omits a stack that holds none', () => {
    const many = Array.from({ length: 40 }, (_, i) => `    at f${i} (https://h.test/_next/static/a.js:${i}:1)`).join('\n');
    expect(lineOf({ stack: many }).frames).toHaveLength(MAX_STACK_FRAMES);
    expect(lineOf({ stack: undefined }).frames).toEqual([]);
    expect(lineOf({ stack: 42 }).frames).toEqual([]);
  });

  it('masks a function name that is not a name', () => {
    expect(lineOf({ stack: '    at /Users/jane/Tax return.pdf (https://h.test/_next/static/a.js:1:2)' }).frames).toEqual(['? /_next/static/a.js:1:2']);
  });
});

describe('the browser family', () => {
  it.each([
    [CHROME_UA, 'chrome'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'edge'],
    ['Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0', 'opera'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0', 'firefox'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1', 'chrome'],
    ['curl/8.4.0', 'other'],
    ['', 'other'],
    [null, 'other'],
  ])('reads %s as %s', (userAgent, family) => {
    expect(browserFamilyOf(userAgent)).toBe(family);
  });
});
