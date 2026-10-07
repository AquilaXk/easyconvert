/**
 * The contract between the OPFS streaming runners and the format transformers.
 *
 * A runner reads the input in windows and calls the transformer once per window, in order, with the window's
 * byte offset and the total input size. The window that reaches the end of the input (`isLastChunk`) is the
 * transformer's signal to flush: emit the bytes it still holds, finish a compressed stream and check that the
 * input was complete. A transformer answers with the output bytes, or, when one window can expand into more
 * than a window of output (an inflater), with an async sequence of pieces that the runner writes one by one,
 * so the memory a transformer needs stays bounded whatever the input expands to.
 */

export type ChunkTransformerFn = (
  chunk: Uint8Array,
  offset: number,
  totalSize: number
) => Uint8Array | Promise<Uint8Array> | AsyncIterable<Uint8Array>;

/** True when the window starting at `offset` with `length` bytes reaches the end of an input of `totalSize`. */
export function isLastChunk(offset: number, length: number, totalSize: number): boolean {
  return offset + length >= totalSize;
}

function isAsyncSequence(
  result: Uint8Array | Promise<Uint8Array> | AsyncIterable<Uint8Array>
): result is AsyncIterable<Uint8Array> {
  return typeof (result as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function';
}

/** Hands every output piece of one transformer call to `sink`, in order, awaiting each before the next. */
export async function forEachOutputPiece(
  result: Uint8Array | Promise<Uint8Array> | AsyncIterable<Uint8Array>,
  sink: (piece: Uint8Array) => void | Promise<void>
): Promise<void> {
  if (isAsyncSequence(result)) {
    for await (const piece of result) await sink(piece);
    return;
  }
  await sink(await result);
}

/** Collects every output piece of one transformer call into one array. */
export async function collectOutput(
  result: Uint8Array | Promise<Uint8Array> | AsyncIterable<Uint8Array>
): Promise<Uint8Array> {
  const pieces: Uint8Array[] = [];
  await forEachOutputPiece(result, (piece) => {
    pieces.push(piece);
  });
  const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}
