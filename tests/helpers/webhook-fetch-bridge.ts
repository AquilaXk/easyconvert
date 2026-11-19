import { webhookDispatcher } from '../../src/lib/api-keys/webhook-dispatcher';

/**
 * Importing this file makes the shared webhook dispatcher deliver through whatever `globalThis.fetch` is when a delivery is sent, so a
 * test that stubs `fetch` sees the deliveries. The product never does that (the dispatcher uses undici's fetch through its pinned
 * dispatcher, tests/webhook-dispatcher-pinned-fetch.test.ts); the test says so by importing this.
 */
webhookDispatcher.useFetch(((input: unknown, init?: unknown) => (globalThis.fetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init)) as never);
