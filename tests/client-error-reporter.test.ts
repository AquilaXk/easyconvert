// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ERROR_PATH, CLIENT_ERROR_REPORTS_PER_PAGE_LOAD, MAX_MESSAGE_CHARS, MAX_STACK_CHARS, type ClientErrorReport } from '../src/lib/client-errors/report';
import { createClientErrorReporter } from '../src/lib/client-errors/reporter';

/** What a page sends when it crashes: one report for each distinct error, at most five a page load, and never a failure of its own. */

const OWN_ORIGIN = 'https://convert.example.test';
let sent: ClientErrorReport[];
const uninstall: Array<() => void> = [];

function reporter(...[release]: [release?: string | null]) {
  return createClientErrorReporter({
    send: (body) => sent.push(JSON.parse(body) as ClientErrorReport),
    pagePath: () => '/ko/pdf-to-jpg',
    ownOrigin: OWN_ORIGIN,
    release: release === null ? undefined : (release ?? 'abc1234'),
  });
}

beforeEach(() => {
  sent = [];
});

afterEach(() => {
  for (const stop of uninstall.splice(0)) stop();
});

describe('reporting an error', () => {
  it('sends the kind, the name, the message, the stack, the page path and the release', () => {
    const error = new TypeError('x is not a function');
    reporter().report('error', error);
    expect(sent).toEqual([{ kind: 'error', name: 'TypeError', message: 'x is not a function', stack: error.stack, path: '/ko/pdf-to-jpg', release: 'abc1234' }]);
  });

  it('carries the digest of an error of a server component, and leaves the release out when the build has none', () => {
    const error = Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '1234567890' });
    reporter(null).report('boundary', error);
    expect(sent[0]).toMatchObject({ kind: 'boundary', digest: '1234567890' });
    expect(sent[0]).not.toHaveProperty('release');
  });

  it('cuts a message and a stack to their limits', () => {
    const error = new Error('m'.repeat(5000));
    error.stack = 's'.repeat(50_000);
    reporter().report('error', error);
    expect(sent[0].message).toHaveLength(MAX_MESSAGE_CHARS);
    expect(sent[0].stack).toHaveLength(MAX_STACK_CHARS);
  });

  it('names a value that is not an error by its type and never sends the value', () => {
    reporter().report('unhandledrejection', 'jane@example.com uploaded tax-return.pdf');
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(sent[0])).not.toMatch(/jane|tax-return/);
    expect(sent[0]).toMatchObject({ name: 'NonError', message: 'A value of type string was thrown.' });
  });

  it('reads an error from another frame, which is not an instance of this frame\'s Error', () => {
    reporter().report('error', { name: 'RangeError', message: 'out of range', stack: 'RangeError: out of range' });
    expect(sent[0]).toMatchObject({ name: 'RangeError', message: 'out of range' });
  });
});

describe('the cap and the dedupe of a page load', () => {
  it('sends an error that repeats once', () => {
    const subject = reporter();
    for (let again = 0; again < 20; again++) subject.report('error', new Error('same'));
    expect(sent).toHaveLength(1);
  });

  it('sends the same message as another kind of report', () => {
    const subject = reporter();
    subject.report('error', new Error('same'));
    subject.report('boundary', new Error('same'));
    expect(sent.map((report) => report.kind)).toEqual(['error', 'boundary']);
  });

  it('sends no more than five distinct errors', () => {
    const subject = reporter();
    for (let n = 0; n < 50; n++) subject.report('error', new Error(`failure ${n}`));
    expect(sent).toHaveLength(CLIENT_ERROR_REPORTS_PER_PAGE_LOAD);
  });

  it('does not let a failure to send throw into the page, and goes on with the next error', () => {
    const send = vi.fn(() => {
      throw new Error('network down');
    });
    const subject = createClientErrorReporter({ send, pagePath: () => '/', ownOrigin: OWN_ORIGIN, release: undefined });
    subject.report('error', new Error('first'));
    subject.report('error', new Error('second'));
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('the handlers of the window', () => {
  function installed() {
    const subject = reporter();
    uninstall.push(subject.install(window));
    return subject;
  }

  function fire(type: 'error' | 'unhandledrejection', init: Record<string, unknown>): void {
    const event = new Event(type);
    Object.assign(event, init);
    window.dispatchEvent(event);
  }

  it('reports an uncaught error and an unhandled rejection', () => {
    installed();
    fire('error', { error: new Error('uncaught'), message: 'Uncaught Error: uncaught', filename: `${OWN_ORIGIN}/_next/static/a.js` });
    fire('unhandledrejection', { reason: new Error('rejected') });
    expect(sent.map((report) => [report.kind, report.message])).toEqual([
      ['error', 'uncaught'],
      ['unhandledrejection', 'rejected'],
    ]);
  });

  it('reads a rejection that a script wrapped in a CustomEvent (an extension does this)', () => {
    installed();
    fire('unhandledrejection', { detail: { reason: new Error('wrapped') } });
    expect(sent[0]).toMatchObject({ kind: 'unhandledrejection', message: 'wrapped' });
  });

  it.each([
    ['an error of a script of another origin', { error: new Error('foreign'), filename: 'https://cdn.paddle.com/paddle.js' }],
    ['an error of an extension', { error: new Error('extension'), filename: 'chrome-extension://abcdefgh/content.js' }],
    ['an error the browser hides from the page', { error: undefined, message: 'Script error.', filename: '' }],
    ['the loop warning of a resize observer', { error: undefined, message: 'ResizeObserver loop completed with undelivered notifications.', filename: `${OWN_ORIGIN}/_next/static/a.js` }],
  ])('leaves out %s', (_label, init) => {
    installed();
    fire('error', init);
    expect(sent).toEqual([]);
  });

  it('leaves out the abort of a request the page cancelled', () => {
    installed();
    fire('unhandledrejection', { reason: new DOMException('The operation was aborted.', 'AbortError') });
    expect(sent).toEqual([]);
  });

  it('installs its handlers once', () => {
    const subject = installed();
    subject.install(window);
    fire('error', { error: new Error('once'), filename: `${OWN_ORIGIN}/_next/static/a.js` });
    expect(sent).toHaveLength(1);
  });
});

describe('the request', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a same-origin POST that outlives the page, with no cookie, and its failure is swallowed', async () => {
    const fetchStub = vi.fn(async () => {
      throw new Error('offline');
    });
    vi.stubGlobal('fetch', fetchStub);
    const { reportClientError } = await import('../src/lib/client-errors/reporter');
    reportClientError('error', new Error('boom'));
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    const [url, init] = fetchStub.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CLIENT_ERROR_PATH);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(String(init.body))).toMatchObject({ kind: 'error', message: 'boom', path: window.location.pathname });
  });
});
