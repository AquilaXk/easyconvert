import { describe, expect, it } from 'vitest';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';

/**
 * A caller that wraps a process's output in a container format can ask for room before and after the output in the
 * buffer it is collected into, and write its header and padding there instead of copying the output again.
 */
const SHELL = '/bin/sh';
const OUTPUT = 'hello, framed output';

async function run(options: { stdoutHeadroomBytes?: number; stdoutTailroomBytes?: number }): Promise<Awaited<ReturnType<typeof executeSandboxedBinary>>> {
  return executeSandboxedBinary(SHELL, ['-c', `printf '%s' '${OUTPUT}'`], { networkIsolated: false, timeoutMs: 10_000, ...options });
}

describe('executeSandboxedBinary output room', () => {
  it('returns the output between the requested head room and tail room of one buffer', async () => {
    const result = await run({ stdoutHeadroomBytes: 7, stdoutTailroomBytes: 11 });
    expect(result.stdout.toString('utf8')).toBe(OUTPUT);
    const frame = result.stdoutFrame!;
    expect(frame.length).toBe(7 + OUTPUT.length + 11);
    expect(frame.subarray(7, 7 + OUTPUT.length).toString('utf8')).toBe(OUTPUT);
    // The output is a view of the frame, so writing into the rooms needs no copy of it.
    frame.fill(0x41, 0, 7);
    frame.fill(0x42, frame.length - 11);
    expect(frame.toString('latin1')).toBe(`AAAAAAA${OUTPUT}BBBBBBBBBBB`);
    expect(result.stdout.buffer).toBe(frame.buffer);
  });

  it('returns the plain output and no frame when no room is requested', async () => {
    const result = await run({});
    expect(result.stdout.toString('utf8')).toBe(OUTPUT);
    expect(result.stdoutFrame).toBeUndefined();
  });

  it('keeps an empty output between its rooms', async () => {
    const result = await executeSandboxedBinary(SHELL, ['-c', 'true'], { networkIsolated: false, timeoutMs: 10_000, stdoutHeadroomBytes: 3, stdoutTailroomBytes: 5 });
    expect(result.stdout.length).toBe(0);
    expect(result.stdoutFrame!.length).toBe(8);
  });
});
