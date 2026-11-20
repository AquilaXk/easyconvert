/**
 * What a program prints when it fails (the build banner and configure line of FFmpeg, library versions, a Python traceback,
 * working directories) is for the operator. It is written to the server log here and is never part of an answer, a stored job
 * error or a problem `detail`: the error that reaches the caller names the step and the exit status only.
 */

/** The log keeps the end of the output, where the error is: a banner and the input description come first. */
const MAX_RECORDED_CHARS = 4_000;

/** Records the output of a failed program in the server log, one JSON line. */
export function recordEngineOutput(engine: string, step: string, output: string): void {
  const text = output.trim();
  if (text === '') return;
  console.warn(JSON.stringify({ event: 'engine-output', engine, step, output: text.slice(-MAX_RECORDED_CHARS) }));
}

/** How a program that ran and failed ended, as a caller may be told: its exit status, or the signal that stopped it. */
export function endOfRun(run: { exitCode: number | null; signal: NodeJS.Signals | null }): string {
  return run.signal ? `it was stopped by ${run.signal}` : `it exited with status ${run.exitCode}`;
}
