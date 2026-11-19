import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebhookDispatcher } from '../src/lib/api-keys/webhook-dispatcher';

/**
 * A webhook delivery goes through undici's fetch and the dispatcher that checks the address it connects to (`createSsrfSafeAgent`), whatever
 * `globalThis.fetch` is. The framework replaces `globalThis.fetch` in the web process, and the dispatcher used to take a replaced one for a
 * test seam and deliver through it without the pinned dispatcher, so the address check was skipped. A test injects a fetch explicitly.
 */
const TARGET_ORIGIN = 'https://93.184.215.14';
const HEADERS = { 'content-type': 'application/json' };

async function attempt(dispatcher: WebhookDispatcher) {
  return (dispatcher as unknown as {
    executeFetchAttempt(url: string, headers: Record<string, string>, body: string, timeoutMs: number, attempt: number): Promise<{ statusCode?: number; statusAction: string }>;
  }).executeFetchAttempt(`${TARGET_ORIGIN}/hook`, HEADERS, '{}', 2000, 1);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the fetch of a webhook delivery', () => {
  it('is undici through the pinned dispatcher when globalThis.fetch has been replaced', async () => {
    const replaced = vi.fn(async () => new Response('replaced', { status: 200 }));
    vi.stubGlobal('fetch', replaced);
    const pinned = new MockAgent();
    pinned.disableNetConnect();
    pinned.get(TARGET_ORIGIN).intercept({ path: '/hook', method: 'POST' }).reply(204, '');

    const result = await attempt(new WebhookDispatcher(pinned as never));

    expect(replaced).not.toHaveBeenCalled();
    expect(result.statusCode).toBe(204);
    pinned.assertNoPendingInterceptors();
  });

  it('is the injected fetch, called with the pinned dispatcher, when a test injects one', async () => {
    const pinned = new MockAgent();
    const injected = vi.fn(async () => new Response('', { status: 202 }));

    const result = await attempt(new WebhookDispatcher(pinned as never, injected as never));

    expect(result.statusCode).toBe(202);
    expect(injected).toHaveBeenCalledTimes(1);
    expect((injected.mock.calls[0] as unknown[])[1]).toMatchObject({ dispatcher: pinned, redirect: 'manual' });
  });
});
