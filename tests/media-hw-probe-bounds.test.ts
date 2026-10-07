import { describe, expect, beforeAll, afterAll, afterEach, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InvalidMediaOptionError } from '../src/lib/types';
import {
  buildFfmpegArguments,
  probeHardwareAcceleration,
  resetHardwareAccelerationCache,
} from '../src/lib/conversions/media-ffmpeg-args';

/**
 * The hardware capability probe runs synchronously on the conversion path, so it must be bounded
 * (a child that ignores SIGTERM cannot hold it past its timeout), cached per ffmpeg binary, and
 * not repeat within the cache lifetime. Stand-in binaries are POSIX shell scripts.
 */

const LIST_TIMEOUT_MS = 3000;
const SESSION_TIMEOUT_MS = 5000;
/** Slack over a probe's own timeout for process teardown on a loaded machine; the stand-in sleeps 30 s, so 10 s still tells a kill from a wait. */
const KILL_SLACK_MS = 10_000;
const MANY_CALLS = 1000;
const MINUTE_MS = 60_000;
const TEST_TIMEOUT_MS = 30_000;

let workDir: string;
const noPosixShell = process.platform === 'win32';

/** Writes an executable stand-in ffmpeg script and returns its path. */
function makeBinary(name: string, lines: string[]): string {
  const dir = path.join(workDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'ffmpeg');
  fs.writeFileSync(bin, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o755 });
  return bin;
}

function invocations(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
}

const NVENC_ROW = " V....D h264_nvenc           NVIDIA NVENC H.264 encoder";

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-hw-probe-bounds-'));
});

afterEach(() => {
  vi.useRealTimers();
  resetHardwareAccelerationCache();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('probe timeouts', () => {
  it.skipIf(noPosixShell)('stops an encoder listing that ignores SIGTERM at the timeout', () => {
    // exec keeps the SIGTERM-ignoring disposition and leaves no orphan holding the pipe.
    const bin = makeBinary('list-hangs', ["trap '' TERM", 'exec sleep 30']);
    const started = Date.now();
    const caps = probeHardwareAcceleration(bin);
    expect(Date.now() - started).toBeLessThan(LIST_TIMEOUT_MS + KILL_SLACK_MS);
    expect(caps.supportedEncoders.size).toBe(0);
    expect(caps.nvenc).toBe(false);
  }, TEST_TIMEOUT_MS);

  it.skipIf(noPosixShell)('stops a hardware session probe that ignores SIGTERM at the timeout', () => {
    const bin = makeBinary('session-hangs', [
      'for a in "$@"; do',
      `  if [ "$a" = "-encoders" ]; then printf '%s\\n' "${NVENC_ROW}"; exit 0; fi`,
      'done',
      "trap '' TERM",
      'exec sleep 30',
    ]);
    const started = Date.now();
    const caps = probeHardwareAcceleration(bin);
    expect(Date.now() - started).toBeLessThan(SESSION_TIMEOUT_MS + KILL_SLACK_MS);
    expect(caps.supportedEncoders.has('h264_nvenc')).toBe(true);
    expect(caps.nvenc).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe('probe cache', () => {
  function countingBinary(name: string, row: string): { bin: string; log: string } {
    const dir = path.join(workDir, name);
    fs.mkdirSync(dir, { recursive: true });
    const log = path.join(dir, 'invocations.log');
    const bin = makeBinary(name, [
      'for a in "$@"; do',
      `  if [ "$a" = "-encoders" ]; then echo listing >> "${log}"; printf '%s\\n' "${row}"; exit 0; fi`,
      'done',
      `echo session >> "${log}"`,
      'exit 0',
    ]);
    return { bin, log };
  }

  it.skipIf(noPosixShell)('spawns ffmpeg once for 1000 calls within the cache lifetime', () => {
    const { bin, log } = countingBinary('once', NVENC_ROW);
    for (let i = 0; i < MANY_CALLS; i++) probeHardwareAcceleration(bin);
    expect(invocations(log).filter((entry) => entry === 'listing')).toHaveLength(1);
  });

  it.skipIf(noPosixShell)('keeps independent results per ffmpeg binary', () => {
    const withNvenc = countingBinary('with-nvenc', NVENC_ROW);
    const without = countingBinary('without-nvenc', ' A....D libmp3lame  MP3');
    const first = probeHardwareAcceleration(withNvenc.bin);
    const second = probeHardwareAcceleration(without.bin);
    expect(first.supportedEncoders.has('h264_nvenc')).toBe(true);
    expect(second.supportedEncoders.has('h264_nvenc')).toBe(false);
    expect(second.supportedEncoders.has('libmp3lame')).toBe(true);
    // Probing the second binary must not evict the first.
    expect(probeHardwareAcceleration(withNvenc.bin)).toBe(first);
    expect(invocations(withNvenc.log).filter((entry) => entry === 'listing')).toHaveLength(1);
  });

  it.skipIf(noPosixShell)('re-probes only after ten minutes', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const { bin, log } = countingBinary('ttl', NVENC_ROW);
    probeHardwareAcceleration(bin);
    vi.setSystemTime(new Date('2030-01-01T00:09:00Z'));
    probeHardwareAcceleration(bin);
    expect(invocations(log).filter((entry) => entry === 'listing')).toHaveLength(1);
    vi.setSystemTime(new Date(Date.parse('2030-01-01T00:00:00Z') + 11 * MINUTE_MS));
    probeHardwareAcceleration(bin);
    expect(invocations(log).filter((entry) => entry === 'listing')).toHaveLength(2);
  });
});

describe('video codec names', () => {
  const build = (codec: string) =>
    buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
      disableHwaccel: true,
      video: { codec } as never,
    });

  it('treats h265 as an alias of hevc', () => {
    const args = build('h265');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx265');
  });

  it('rejects an unknown video codec instead of encoding h264', () => {
    expect(() => build('h266')).toThrow(InvalidMediaOptionError);
    expect(() => build('divx')).toThrow(/divx/);
  });

  it('applies the same alias and check to the legacy videoCodec option', () => {
    const legacy = (codec: string) =>
      buildFfmpegArguments('/nonexistent/in.mp4', '/tmp/out.mp4', 'mp4', 'mp4', {
        disableHwaccel: true,
        videoCodec: codec as never,
      });
    expect(legacy('h265')[legacy('h265').indexOf('-c:v') + 1]).toBe('libx265');
    expect(() => legacy('mpeg2')).toThrow(InvalidMediaOptionError);
  });
});
