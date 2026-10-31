import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from './process-sandbox';
import { SandboxUnavailableError } from '../types';
import {
  capStream,
  encodeFrame,
  ERROR_MESSAGE_HEAD_BYTES,
  ERROR_MESSAGE_TAIL_BYTES,
  ERROR_STREAM_HEAD_BYTES,
  ERROR_STREAM_TAIL_BYTES,
  FrameReader,
  isBadFrame,
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

interface Described {
  detail: LauncherErrorDetail;
  /** What the program printed, capped to its ends; sent as the payload. */
  stdout: Buffer;
  stderr: Buffer;
}

const NO_TEXT = Buffer.alloc(0);

function shortMessage(message: string): string {
  return capStream(Buffer.from(message, 'utf8'), ERROR_MESSAGE_HEAD_BYTES, ERROR_MESSAGE_TAIL_BYTES).toString('utf8');
}

function describe(error: unknown): Described {
  if (error instanceof SandboxedProcessError) {
    const stdout = capStream(Buffer.from(error.stdout, 'utf8'), ERROR_STREAM_HEAD_BYTES, ERROR_STREAM_TAIL_BYTES);
    const stderr = capStream(Buffer.from(error.stderr, 'utf8'), ERROR_STREAM_HEAD_BYTES, ERROR_STREAM_TAIL_BYTES);
    return {
      detail: { kind: 'process', message: shortMessage(error.message), exitCode: error.exitCode, signal: error.signal, stdoutBytes: stdout.length },
      stdout,
      stderr,
    };
  }
  const plain = (detail: LauncherErrorDetail): Described => ({ detail, stdout: NO_TEXT, stderr: NO_TEXT });
  if (error instanceof SandboxedTimeoutError) return plain({ kind: 'timeout', message: error.message, timeoutMs: error.timeoutMs });
  if (error instanceof SandboxedBufferLimitError) return plain({ kind: 'buffer', message: error.message, limitBytes: error.limitBytes });
  if (error instanceof SandboxedMemoryLimitError) return plain({ kind: 'memory', message: error.message, limitMb: error.limitMb, signal: error.signal });
  if (error instanceof SandboxUnavailableError) return plain({ kind: 'unavailable', message: shortMessage(error.reason) });
  return plain({ kind: 'other', message: shortMessage(error instanceof Error ? error.message : String(error)) });
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
    if (controller.signal.aborted) {
      send({ type: 'error', id: request.id, error: { kind: 'aborted', message: 'cancelled' } });
    } else {
      const { detail, stdout, stderr } = describe(error);
      send({ type: 'error', id: request.id, error: detail }, stdout, stderr);
    }
  } finally {
    running.delete(request.id);
  }
}

/** Stops every program still running, each in its own process group; the kill is made before this returns. */
function abortAll(): void {
  for (const controller of running.values()) controller.abort();
}

function main(): void {
  const reader = new FrameReader<LauncherRequest>();
  process.stdin.on('data', (chunk: Buffer) => {
    try {
      for (const frame of reader.push(chunk)) {
        // A request the helper cannot read is a worker that is out of step with it: nothing is left to trust.
        if (isBadFrame(frame)) process.exit(1);
        if (frame.header.type === 'cancel') running.get(frame.header.id)?.abort();
        else void run(frame.header, frame.payload);
      }
    } catch {
      process.exit(1);
    }
  });
  // Whichever way the helper ends (input closed, a request it cannot read, a signal, a crash), the programs it started
  // go with it: they run in their own process groups, so nothing else would stop them or hold them to a limit. Only a
  // kill the process cannot handle (SIGKILL, the out-of-memory killer) leaves them running.
  process.on('exit', abortAll);
  process.stdin.on('end', () => process.exit(0));
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.exit(0));
  process.on('uncaughtException', () => process.exit(1));
  process.on('unhandledRejection', () => process.exit(1));
  send({ type: 'ready' });
}

main();
