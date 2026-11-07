/**
 * Every answer of the mail routes that could tell a known address from an unknown one leaves after the same time. The
 * work behind a known address (a token and a mail) is queued and not awaited, and is far shorter than this, so the answer
 * does not wait for it and its duration does not depend on the address.
 */
export const OPAQUE_RESPONSE_MS = 1500;

/** Waits until `ms` have passed since `startedAt` (a `performance.now()` reading); returns at once when they have. */
export async function holdUntil(startedAt: number, ms: number = OPAQUE_RESPONSE_MS): Promise<void> {
  const remaining = startedAt + ms - performance.now();
  if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
}
