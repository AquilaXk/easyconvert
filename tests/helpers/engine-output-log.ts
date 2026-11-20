import { vi } from 'vitest';

/**
 * Captures what `recordEngineOutput` (src/lib/engine-output.ts) writes to the server log while a test runs. The output of a failed
 * program is not part of the error a caller reads; a test that wants to know what the program saw or printed reads it here.
 */
export interface EngineOutputLog {
  /** The output of every failed program recorded so far, in order. */
  outputs(): string[];
  /** The engine names of the records, in order. */
  engines(): string[];
  restore(): void;
}

export function captureEngineOutput(): EngineOutputLog {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const records = (): Array<{ engine: string; output: string }> =>
    warn.mock.calls.flatMap(([line]) => {
      try {
        const parsed = JSON.parse(String(line)) as { event?: string; engine: string; output: string };
        return parsed.event === 'engine-output' ? [parsed] : [];
      } catch {
        return [];
      }
    });
  return {
    outputs: () => records().map((record) => record.output),
    engines: () => records().map((record) => record.engine),
    restore: () => warn.mockRestore(),
  };
}
