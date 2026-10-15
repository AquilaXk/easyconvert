/** Runs `run` and returns the error it rejects with; fails when it resolves instead. */
export async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error('expected the conversion to reject, but it resolved');
}
