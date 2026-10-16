import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from './process-sandbox';
import { SandboxUnavailableError } from '../types';
import {
  encodeFrame,
  FrameReader,
  type LauncherErrorDetail,
  type LauncherReply,
  type LauncherRequest,
} from './sandbox-launcher-protocol';

/**
 * The launcher helper: a small process that starts the programs of the worker.
 *
 * Starting a program forks the starting process, and a fork costs time in proportion to the memory the parent has
 * mapped (a worker that holds a few hundred megabytes spends longer in the fork than a small PDF tool spends running).
 * This process stays small, so the fork it makes is cheap. Every program still starts through executeSandboxedBinary,
 * with the environment, the namespaces, the limits, the time limit and the output limit the worker asked for.
 *
 * It reads frames on stdin (see sandbox-launcher-protocol.ts), answers on stdout, and ends when the worker closes
 * stdin, taking the programs still running with it.
 */

const running = new Map<number, AbortController>();

function describe(error: unknown): LauncherErrorDetail {
  if (error instanceof SandboxedProcessError) {
    return { kind: 'process', message: error.message, exitCode: error.exitCode, signal: error.signal, stderr: error.stderr, stdout: error.stdout };
  }
  if (error instanceof SandboxedTimeoutError) return { kind: 'timeout', message: error.message, timeoutMs: error.timeoutMs };
  if (error instanceof SandboxedBufferLimitError) return { kind: 'buffer', message: error.message, limitBytes: error.limitBytes };
  if (error instanceof SandboxedMemoryLimitError) return { kind: 'memory', message: error.message, limitMb: error.limitMb };
  if (error instanceof SandboxUnavailableError) return { kind: 'unavailable', message: error.reason };
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'other', message };
}

function send(header: LauncherReply, ...payload: Buffer[]): void {
  process.stdout.cork();
  for (const part of encodeFrame(header, ...payload)) process.stdout.write(part);
  process.stdout.uncork();
}

async function run(request: Extract<LauncherRequest, { type: 'run' }>, stdin: Buffer): Promise<void> {
  const controller = new AbortController();
  running.set(request.id, controller);
  try {
    const result = await executeSandboxedBinary(request.binary, request.args, {
      ...request.options,
      stdin: request.hasStdin ? stdin : undefined,
      signal: controller.signal,
    });
    send(
      { type: 'result', id: request.id, exitCode: result.exitCode, durationMs: result.durationMs, sandboxed: result.sandboxed, sandboxType: result.sandboxType, stdoutBytes: result.stdout.length },
      result.stdout,
      result.stderr
    );
  } catch (error) {
    send({ type: 'error', id: request.id, error: controller.signal.aborted ? { kind: 'aborted', message: 'cancelled' } : describe(error) });
  } finally {
    running.delete(request.id);
  }
}

function main(): void {
  const reader = new FrameReader<LauncherRequest>();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const { header, payload } of reader.push(chunk)) {
        if (header.type === 'cancel') running.get(header.id)?.abort();
        else void run(header, payload);
      }
    } catch {
      process.exit(1);
    }
  });
  process.stdin.on('end', () => {
    for (const controller of running.values()) controller.abort();
    // Aborting kills the process group of each program at once; the worker that would read the replies is gone.
    process.exit(0);
  });
  process.on('SIGTERM', () => process.exit(0));
  send({ type: 'ready' });
}

main();
