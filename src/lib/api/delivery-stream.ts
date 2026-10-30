import { Readable } from 'node:stream';

/**
 * A response body that tells how much of it the server handed to the client. It reads `source` only when the
 * consumer asks for more (a queue size of 0), so every byte it enqueues has been asked for by the consumer, which
 * writes it to the connection.
 *
 * `onSent` runs once. When `source` ended and exactly `expectedBytes` were enqueued, it gets `expectedBytes` before
 * the stream closes, so the record of a complete delivery is written before the client sees the end of the body.
 * When the consumer cancels (the client went away), it gets the bytes enqueued until then, which can be 0; a read
 * of `source` that was still waiting when the cancel came does not count. A read error of `source` reaches the
 * consumer as an error of the body, also when nobody reads it, and reports nothing.
 */
export function deliveryTrackedStream(
  source: Readable,
  expectedBytes: number,
  onSent: (bytes: number) => Promise<void>
): ReadableStream<Uint8Array> {
  const reader = Readable.toWeb(source).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  let enqueued = 0;
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) {
          if (enqueued === expectedBytes) await onSent(enqueued);
          controller.close();
          return;
        }
        enqueued += next.value.byteLength;
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        cancelled = true;
        await reader.cancel(reason);
        await onSent(enqueued);
      },
    },
    { highWaterMark: 0 }
  );
}
