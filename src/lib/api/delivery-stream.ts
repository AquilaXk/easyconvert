import { Readable } from 'node:stream';

/**
 * A response body that tells when the client took all of it. It reads `source` only when the consumer asks for
 * more (a queue size of 0), so the end of the stream is reached after the consumer has taken the last chunk
 * and asked for another. A client that disconnects first cancels the stream and `onDelivered` is never called,
 * which is how a dropped download is told from a finished one.
 *
 * `onDelivered` runs before the stream closes, so the record of the delivery is written before the client sees
 * the end of the body. A read error of `source` reaches the consumer as an error of the body, also when nobody
 * reads it.
 */
export function deliveryTrackedStream(source: Readable, onDelivered: () => Promise<void>): ReadableStream<Uint8Array> {
  const reader = Readable.toWeb(source).getReader() as ReadableStreamDefaultReader<Uint8Array>;
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          await onDelivered();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
}
