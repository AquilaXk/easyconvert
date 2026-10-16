import type { SandboxedRlimitsOptions, UnshareIsolationOptions } from './process-sandbox';

/**
 * What the worker and its launcher helper (sandbox-launcher.ts, sandbox-launcher-child.ts) say to each other.
 *
 * A frame is `u32 header length | u32 payload length | header (JSON) | payload`. The header names the request or the
 * reply; the payload carries bytes (the standard input of a request, the standard output and error of a reply), so a
 * document never passes through JSON.
 */

export const FRAME_PREFIX_BYTES = 8;
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

export interface LauncherErrorDetail {
  kind: LauncherErrorKind;
  message: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  timeoutMs?: number;
  limitBytes?: number;
  limitMb?: number;
}

export type LauncherReply =
  | { type: 'ready' }
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

/** A peer that sent something that is not a frame. */
export class LauncherProtocolError extends Error {}

/** Cuts a stream of chunks into frames, joining the chunks of a frame once, when it is complete. */
export class FrameReader<T> {
  private chunks: Buffer[] = [];
  private total = 0;
  private needed = 0;

  push(chunk: Buffer): Array<Frame<T>> {
    this.chunks.push(chunk);
    this.total += chunk.length;
    const frames: Array<Frame<T>> = [];
    for (;;) {
      if (this.needed === 0) {
        if (this.total < FRAME_PREFIX_BYTES) break;
        const joined = this.join();
        const headerBytes = joined.readUInt32BE(0);
        if (headerBytes > MAX_HEADER_BYTES) throw new LauncherProtocolError('frame header too long');
        this.needed = FRAME_PREFIX_BYTES + headerBytes + joined.readUInt32BE(4);
      }
      if (this.total < this.needed) break;
      const joined = this.join();
      const headerBytes = joined.readUInt32BE(0);
      const headerEnd = FRAME_PREFIX_BYTES + headerBytes;
      let header: T;
      try {
        header = JSON.parse(joined.toString('utf8', FRAME_PREFIX_BYTES, headerEnd)) as T;
      } catch {
        throw new LauncherProtocolError('frame header is not JSON');
      }
      frames.push({ header, payload: joined.subarray(headerEnd, this.needed) });
      const rest = joined.subarray(this.needed);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
      this.needed = 0;
    }
    return frames;
  }

  private join(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0];
  }
}
