import type { SandboxedRlimitsOptions, UnshareIsolationOptions } from './process-sandbox';

/**
 * What the worker and its launcher helper (sandbox-launcher.ts, sandbox-launcher-child.ts) say to each other.
 *
 * A frame is `u32 header length | u32 payload length | header (JSON) | payload`. The header names the request or the
 * reply; the payload carries bytes (the standard input of a request, the standard output and error of a reply), so a
 * document never passes through JSON.
 */

export const FRAME_PREFIX_BYTES = 8;
/**
 * Set by the worker for a helper it starts under `unshare`: the network namespace the worker itself is in (the target of
 * `/proc/self/ns/net`). The helper compares it with its own to learn that it sits in a namespace of its own.
 */
export const PARENT_NETNS_ENV = 'SANDBOX_LAUNCHER_PARENT_NETNS';
/** A header is a few hundred bytes of JSON; one this long is not from the peer. */
export const MAX_HEADER_BYTES = 1024 * 1024;

/** The options of one run that cross the pipe: everything executeSandboxedBinary takes except what is a stream or a callback. */
export interface LaunchedRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  cwd?: string;
  networkIsolated?: boolean;
  /** Resolved by the worker (STRICT_SANDBOX is part of its environment, not of the helper's). */
  strictIsolation: boolean;
  sandboxOptions?: UnshareIsolationOptions;
  memoryLimitMb?: number;
  maxFileSize?: number;
  rlimits?: SandboxedRlimitsOptions;
}

export type LauncherRequest =
  | { type: 'run'; id: number; binary: string; args: string[]; hasStdin: boolean; options: LaunchedRunOptions }
  | { type: 'cancel'; id: number };

export type LauncherErrorKind = 'process' | 'timeout' | 'buffer' | 'memory' | 'unavailable' | 'aborted' | 'other';

/**
 * A failed run. The text the program printed travels in the payload (standard output, then standard error), capped to
 * its head and tail by capStream, so a program that prints megabytes before it fails cannot overflow a header.
 */
export interface LauncherErrorDetail {
  kind: LauncherErrorKind;
  /** Short: the head and tail of the full message. */
  message: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  /** Length of the standard output in the payload; the standard error follows it. */
  stdoutBytes?: number;
  timeoutMs?: number;
  limitBytes?: number;
  limitMb?: number;
}

/** What is kept of the text a failed program printed: this many bytes from each end. */
export const ERROR_STREAM_HEAD_BYTES = 32 * 1024;
export const ERROR_STREAM_TAIL_BYTES = 32 * 1024;
/** What is kept of the message of an error. */
export const ERROR_MESSAGE_HEAD_BYTES = 512;
export const ERROR_MESSAGE_TAIL_BYTES = 512;

/**
 * `text` with the middle cut out when it is longer than `head + tail` bytes, a note of the cut in its place. The
 * start (where a tool names its error) and the end (where it names its cause) are kept whole.
 */
export function capStream(text: Buffer, head: number, tail: number): Buffer {
  if (text.length <= head + tail) return text;
  const note = Buffer.from(`\n[... ${text.length - head - tail} bytes omitted ...]\n`, 'utf8');
  return Buffer.concat([text.subarray(0, head), note, text.subarray(text.length - tail)]);
}

export type LauncherReply =
  | {
      type: 'ready';
      /** True when the helper checked that it runs in a network namespace of its own with no interface but the loopback, which its programs inherit. */
      netIsolated: boolean;
    }
  | {
      type: 'result';
      id: number;
      exitCode: number;
      durationMs: number;
      sandboxed: boolean;
      sandboxType: 'gvisor' | 'container' | 'host';
      /** The payload is the standard output (this many bytes) followed by the standard error. */
      stdoutBytes: number;
    }
  | { type: 'error'; id: number; error: LauncherErrorDetail };

export interface Frame<T> {
  header: T;
  payload: Buffer;
}

/** The parts of a frame to write one after another; the payload parts are the caller's buffers, not copies. */
export function encodeFrame(header: LauncherRequest | LauncherReply, ...payload: Buffer[]): Buffer[] {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const parts = payload.filter((part) => part.length > 0);
  const prefix = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + json.length);
  prefix.writeUInt32BE(json.length, 0);
  prefix.writeUInt32BE(parts.reduce((sum, part) => sum + part.length, 0), 4);
  json.copy(prefix, FRAME_PREFIX_BYTES);
  return [prefix, ...parts];
}

export function isBadFrame<T>(frame: Frame<T> | BadFrame): frame is BadFrame {
  return 'bad' in frame;
}

/** A peer that sent something that is not a frame. */
export class LauncherProtocolError extends Error {}

/** A frame that could not be read: its header was too long or not JSON. `id` is the request it belongs to, when that can be told. */
export interface BadFrame {
  bad: true;
  id?: number;
  reason: string;
}

const ID_PATTERN = /"id"\s*:\s*(\d{1,15})/;
/** How much of a header is searched for the id: both peers write `type` and `id` first. */
const ID_SEARCH_BYTES = 128;

function idOf(header: Buffer): number | undefined {
  const match = ID_PATTERN.exec(header.toString('utf8', 0, Math.min(header.length, ID_SEARCH_BYTES)));
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Cuts a stream of chunks into frames, joining the chunks of a frame once, when it is complete. A frame with a header
 * that is too long or not JSON comes out as a BadFrame (with the id of its request when the first bytes of the header
 * show it) and its bytes are skipped without being held, so one bad frame does not end the stream.
 */
export class FrameReader<T> {
  private chunks: Buffer[] = [];
  private total = 0;
  private needed = 0;
  private skipping = 0;

  push(chunk: Buffer): Array<Frame<T> | BadFrame> {
    this.chunks.push(chunk);
    this.total += chunk.length;
    const frames: Array<Frame<T> | BadFrame> = [];
    for (;;) {
      if (this.skipping > 0) {
        this.drop(Math.min(this.skipping, this.total));
        if (this.skipping > 0) break;
      }
      if (this.needed === 0) {
        if (this.total < FRAME_PREFIX_BYTES) break;
        const joined = this.join();
        const headerBytes = joined.readUInt32BE(0);
        const payloadBytes = joined.readUInt32BE(4);
        if (headerBytes > MAX_HEADER_BYTES) {
          const seen = joined.subarray(FRAME_PREFIX_BYTES, Math.min(joined.length, FRAME_PREFIX_BYTES + ID_SEARCH_BYTES));
          frames.push({ bad: true, id: idOf(seen), reason: 'frame header too long' });
          this.skipping = FRAME_PREFIX_BYTES + headerBytes + payloadBytes;
          continue;
        }
        this.needed = FRAME_PREFIX_BYTES + headerBytes + payloadBytes;
      }
      if (this.total < this.needed) break;
      const joined = this.join();
      const headerEnd = FRAME_PREFIX_BYTES + joined.readUInt32BE(0);
      const headerBytes = joined.subarray(FRAME_PREFIX_BYTES, headerEnd);
      let header: T | undefined;
      try {
        header = JSON.parse(headerBytes.toString('utf8')) as T;
      } catch {
        frames.push({ bad: true, id: idOf(headerBytes), reason: 'frame header is not JSON' });
      }
      if (header !== undefined) frames.push({ header, payload: joined.subarray(headerEnd, this.needed) });
      const rest = joined.subarray(this.needed);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
      this.needed = 0;
    }
    return frames;
  }

  /** Throws away the next `count` bytes of the stream, which have all arrived. */
  private drop(count: number): void {
    let left = count;
    while (left > 0 && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first.length <= left) {
        this.chunks.shift();
        left -= first.length;
      } else {
        this.chunks[0] = first.subarray(left);
        left = 0;
      }
    }
    this.total -= count;
    this.skipping -= count;
  }

  private join(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0];
  }
}
