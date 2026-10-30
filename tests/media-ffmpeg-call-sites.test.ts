import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFfmpegArguments, buildHlsDashArguments } from '../src/lib/conversions/media-ffmpeg-args';
import {
  enforceFfmpegMinimumVersion,
  ffmpegVersionProblem,
  MEDIA_INPUT_DEMUXERS,
  REFERENCE_INPUT_FORMATS,
  runFfmpeg,
} from '../src/lib/conversions/media-process';
import { resetUnshareCapabilityCache } from '../src/lib/security/process-sandbox';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { EngineUnavailableError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Every ffmpeg and ffprobe process starts in one module, which gives each input a protocol whitelist and a demuxer of the
 * detected format. These tests hold that rule for the code that exists and for code written later.
 */

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const SPAWN_MODULE = path.join('lib', 'conversions', 'media-process.ts');
/** A call that starts a process, whose first argument names an ffmpeg or ffprobe binary. */
const MEDIA_TOOL_SPAWN =
  /\b(?:execFileSync|execFile|spawnSync|spawn|execSync|executeSandboxedBinary|resolveSandboxedCommand)\(\s*(?:[\w.]*ff(?:mpeg|probe)\w*|['"`][^'"`\n]*ff(?:mpeg|probe))/i;
const SPY_MODE = 0o755;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The operands of `-i` whose input options lack `-protocol_whitelist file` or a demuxer choice (`-f` or `-format_whitelist`). */
function unguardedInputs(args: readonly string[]): string[] {
  const unguarded: string[] = [];
  let inputStart = 0;
  args.forEach((arg, index) => {
    if (arg !== '-i') return;
    const options = args.slice(inputStart, index);
    const whitelisted = options.some((option, at) => option === '-protocol_whitelist' && options[at + 1] === 'file');
    const demuxerChosen = options.includes('-f') || options.includes('-format_whitelist');
    if (!whitelisted || !demuxerChosen) unguarded.push(args[index + 1]);
    inputStart = index + 2;
  });
  return unguarded;
}

describe('the call sites of ffmpeg and ffprobe', () => {
  it('start no ffmpeg or ffprobe process outside the one spawning module', () => {
    const rawSpawns = sourceFiles(SRC_ROOT)
      .filter((file) => path.relative(SRC_ROOT, file) !== SPAWN_MODULE)
      .flatMap((file) =>
        readFileSync(file, 'utf-8')
          .split('\n')
          .map((line, index) => ({ line, at: `${path.relative(SRC_ROOT, file)}:${index + 1}` }))
          .filter(({ line }) => MEDIA_TOOL_SPAWN.test(line))
          .map(({ at }) => at)
      );
    expect(rawSpawns).toEqual([]);
  });

  const PACKAGING_SOURCE = {
    geometry: { fpsNum: 30, fpsDen: 1, width: 1280, height: 720, durationSec: 10 },
    hasAudio: true,
  };
  const BUILT: ReadonlyArray<[string, () => string[]]> = [
    ['a video transcode', () => buildFfmpegArguments('/nonexistent/in.mkv', '/nonexistent/out.webm', 'mkv', 'webm', {})],
    ['a trimmed video transcode', () => buildFfmpegArguments('/nonexistent/in.mov', '/nonexistent/out.mp4', 'mov', 'mp4', { trim: { start: '00:00:01', end: '00:00:02' } })],
    ['a thumbnail', () => buildFfmpegArguments('/nonexistent/in.mp4', '/nonexistent/out.jpg', 'mp4', 'jpg', { thumbnail: { at: ['00:00:01'] } })],
    ['an accurate thumbnail', () => buildFfmpegArguments('/nonexistent/in.avi', '/nonexistent/out.png', 'avi', 'png', { thumbnail: { at: ['00:00:01'], accurate: true } })],
    ['a subtitle extraction', () => buildFfmpegArguments('/nonexistent/in.mkv', '/nonexistent/out.srt', 'mkv', 'srt', { subtitles: { mode: 'extract' } })],
    ['a soft subtitle from a file', () => buildFfmpegArguments('/nonexistent/in.mkv', '/nonexistent/out.mkv', 'mkv', 'mkv', { subtitles: { mode: 'soft', input: '/nonexistent/subs.srt' } })],
    ['an HLS package', () => buildHlsDashArguments('/nonexistent/in.mp4', '/nonexistent/out', { format: 'hls' }, null, PACKAGING_SOURCE)],
    ['a DASH package', () => buildHlsDashArguments('/nonexistent/in.webm', '/nonexistent/out', { format: 'dash' }, null, PACKAGING_SOURCE)],
  ];

  it.each(BUILT)('give every input of %s a protocol whitelist and a demuxer', (_, build) => {
    const args = build();
    expect(args.filter((arg) => arg === '-i').length).toBeGreaterThan(0);
    expect(unguardedInputs(args)).toEqual([]);
  });

  it('control: the check finds an input that has neither', () => {
    expect(unguardedInputs(['-y', '-i', '/x/in.mp4', '/x/out.wav'])).toEqual(['/x/in.mp4']);
  });
});

describe('runFfmpeg', () => {
  let spyDir = '';
  let spy = '';
  let spyLog = '';

  beforeAll(() => {
    spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-ffmpeg-guard-'));
    spyLog = path.join(spyDir, 'invocations.log');
    spy = path.join(spyDir, 'ffmpeg');
    writeFileSync(spy, `#!/bin/sh\necho "$*" >> "${spyLog}"\nexit 0\n`);
    chmodSync(spy, SPY_MODE);
  });

  afterAll(() => {
    rmSync(spyDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    rmSync(spyLog, { force: true });
  });

  function started(): boolean {
    return existsSync(spyLog);
  }

  it('does not start ffmpeg for an input without a protocol whitelist and a demuxer', async () => {
    await expect(runFfmpeg(spy, ['-y', '-i', '/x/in.mp4', '/x/out.wav'], {})).rejects.toThrow();
    expect(started()).toBe(false);
  });

  it('does not start ffmpeg with -allowed_extensions ALL', async () => {
    const args = ['-y', '-allowed_extensions', 'ALL', '-protocol_whitelist', 'file', '-f', 'mov', '-i', '/x/in.mp4', '/x/out.wav'];
    await expect(runFfmpeg(spy, args, {})).rejects.toThrow();
    expect(started()).toBe(false);
  });

  it('control: starts ffmpeg when every input is guarded', async () => {
    await runFfmpeg(spy, ['-y', '-protocol_whitelist', 'file', '-f', 'mov', '-i', '/x/in.mp4', '/x/out.wav'], {});
    expect(started()).toBe(true);
  });
});

describe.skipIf(skipWithoutTools('ffmpeg'))('the demuxer table of the media inputs', () => {
  const NOT_DEMUXED = new Set(['mid', 'midi']);

  function installedDemuxers(): Set<string> {
    const listing = execFileSync(requireOracleTool('ffmpeg'), ['-hide_banner', '-demuxers'], { encoding: 'utf-8' });
    const names = new Set<string>();
    for (const line of listing.split('\n')) {
      const match = /^\s*D\S*\s+(\S+)/.exec(line);
      if (match) for (const name of match[1].split(',')) names.add(name);
    }
    return names;
  }

  it('names a demuxer for every audio and video source of the registry', () => {
    const sources = Object.values(FORMAT_REGISTRY)
      .filter((format) => (format.category === 'audio' || format.category === 'video') && !NOT_DEMUXED.has(format.id))
      .map((format) => format.id);
    expect(sources.filter((id) => !Object.hasOwn(MEDIA_INPUT_DEMUXERS, id))).toEqual([]);
  });

  it('names only demuxers the installed FFmpeg has, and none that opens other resources', () => {
    const installed = installedDemuxers();
    const refused = new Set(REFERENCE_INPUT_FORMATS.flatMap((format) => format.demuxers));
    for (const [format, demuxers] of Object.entries(MEDIA_INPUT_DEMUXERS)) {
      expect(demuxers.some((name) => installed.has(name)), `${format}: ${demuxers.join(',')}`).toBe(true);
      expect(demuxers.filter((name) => refused.has(name)), format).toEqual([]);
    }
  });
});

describe('the minimum FFmpeg version', () => {
  let spyDir = '';

  /** An ffmpeg that prints `firstLine` as the first line of `-version`. */
  function ffmpegReporting(name: string, firstLine: string): string {
    const spy = path.join(spyDir, name);
    writeFileSync(spy, `#!/bin/sh\necho "${firstLine}"\necho "built with clang"\n`);
    chmodSync(spy, SPY_MODE);
    return spy;
  }

  beforeAll(() => {
    spyDir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-ffmpeg-version-'));
  });

  afterAll(() => {
    rmSync(spyDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetUnshareCapabilityCache();
  });

  it.each([
    ['ffmpeg version 8.1.3 Copyright (c) 2000-2026 the FFmpeg developers', 'v813'],
    ['ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers', 'v902'],
    ['ffmpeg version n9.0 Copyright (c) 2000-2026 the FFmpeg developers', 'vn90'],
  ])('accepts %s', (firstLine, name) => {
    expect(ffmpegVersionProblem(ffmpegReporting(name, firstLine))).toBeUndefined();
  });

  it.each([
    ['ffmpeg version 8.1.2 Copyright (c) 2000-2026 the FFmpeg developers', 'v812'],
    ['ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers', 'v611'],
    ['ffmpeg version 7.1.5 Copyright (c) 2000-2025 the FFmpeg developers', 'v715'],
    ['ffmpeg version N-120000-gabcdef0123 Copyright (c) 2000-2026 the FFmpeg developers', 'vgit'],
  ])('names the problem of %s', (firstLine, name) => {
    expect(ffmpegVersionProblem(ffmpegReporting(name, firstLine))).toMatch(/8\.1\.3/);
  });

  it('only warns outside STRICT_SANDBOX, so a development host with an older FFmpeg still starts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    enforceFfmpegMinimumVersion(ffmpegReporting('warn611', 'ffmpeg version 6.1.1 Copyright'));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.skipIf(skipUnless('a Linux host (network namespaces)', process.platform === 'linux'))(
    'refuses to start under STRICT_SANDBOX with an FFmpeg older than the minimum',
    () => {
      vi.stubEnv('STRICT_SANDBOX', 'true');
      expect(() => enforceFfmpegMinimumVersion(ffmpegReporting('strict812', 'ffmpeg version 8.1.2 Copyright'))).toThrow(EngineUnavailableError);
      expect(() => enforceFfmpegMinimumVersion(ffmpegReporting('strict902', 'ffmpeg version 9.0.2 Copyright'))).not.toThrow();
    }
  );
});
