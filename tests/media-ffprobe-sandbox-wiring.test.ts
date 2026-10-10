import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How the host looks to the sandbox. `unshare` and `prlimit` are reported present only when `linuxHost` is set, and
 * every spawn of a native tool is recorded instead of run, so the command line a probe starts is asserted without
 * a kernel that grants namespaces. Anything that is not one of those tools runs for real.
 */
const host = vi.hoisted(() => ({
  linuxHost: false,
  prlimitInstalled: true,
  spawns: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>,
  stdout: '',
  sandboxTools: ['/usr/bin/unshare', '/usr/bin/prlimit'],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const existsSync = ((target: unknown) => {
    if (target === '/usr/bin/prlimit') return host.linuxHost && host.prlimitInstalled;
    if (typeof target === 'string' && host.sandboxTools.includes(target)) return host.linuxHost;
    return (actual.existsSync as (t: unknown) => boolean)(target);
  }) as typeof actual.existsSync;
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    // The capability probe of `unshare -r -n -- /bin/true`: the simulated kernel grants it.
    if (host.sandboxTools.includes(file)) return Buffer.alloc(0);
    return (actual.execFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.execFileSync;
  const spawnSync = ((file: string, args: string[], options: Record<string, unknown>) => {
    host.spawns.push({ file, args: [...args], options });
    return { status: 0, signal: null, pid: 1, output: [], stdout: Buffer.from(host.stdout), stderr: Buffer.alloc(0) };
  }) as unknown as typeof actual.spawnSync;
  const spawn = ((file: string, ...rest: unknown[]) => {
    host.spawns.push({ file, args: (rest[0] as string[]) ?? [], options: (rest[1] as Record<string, unknown>) ?? {} });
    return (actual.spawn as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof actual.spawn;
  return { ...actual, default: { ...actual, execFileSync, spawnSync, spawn }, execFileSync, spawnSync, spawn };
});

import { dispatchConversion } from '../src/lib/conversions/dispatch';
import {
  probeAudioChannels,
  probeAudioSampleRate,
  probeAudioStreamCount,
  probeInput,
  probeInputDuration,
  resetInputProbeCache,
  type FfprobePath,
} from '../src/lib/conversions/media-ffprobe';
import { probeVideoMaxLightLevel } from '../src/lib/conversions/media-hdr';
import { probeMediaDuration } from '../src/lib/conversions/media';
import { resetPrlimitCapabilityCache, resetUnshareCapabilityCache, resolveSandboxedCommand } from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';

const FFPROBE = '/opt/test-tools/ffprobe' as FfprobePath;
const STREAMS_JSON = JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3' }], format: { duration: '1.5' } });
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const BYTES_PER_MB = 1024 * 1024;
const UNSHARE = '/usr/bin/unshare';
const PRLIMIT = '/usr/bin/prlimit';

/** Bytes that name no container a header reader understands, so every question goes to ffprobe. */
const OPAQUE_MEDIA = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'.padEnd(512, '\u0000'), 'latin1');

let workDir = '';
let mediaFile = '';
let platformDescriptor: PropertyDescriptor | undefined;

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value });
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'ffprobe-sandbox-wiring-'));
  mediaFile = path.join(workDir, 'input.mp3');
  writeFileSync(mediaFile, OPAQUE_MEDIA);
  platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  host.spawns.length = 0;
  host.stdout = STREAMS_JSON;
  host.linuxHost = false;
  host.prlimitInstalled = true;
  resetInputProbeCache();
  resetUnshareCapabilityCache();
  resetPrlimitCapabilityCache();
});

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  vi.unstubAllEnvs();
  resetUnshareCapabilityCache();
  resetPrlimitCapabilityCache();
});

function linuxHostWithNamespaces(): void {
  stubPlatform('linux');
  host.linuxHost = true;
  vi.stubEnv('STRICT_SANDBOX', 'true');
}

function sandboxDenied(): void {
  stubPlatform('linux');
  host.linuxHost = false;
  vi.stubEnv('STRICT_SANDBOX', 'true');
}

function ffprobeSpawns() {
  return host.spawns.filter((spawn) => spawn.file === UNSHARE || spawn.file === FFPROBE);
}

describe('ffprobe under STRICT_SANDBOX on a host with namespaces', () => {
  it('starts the JSON probe as `unshare -r -n -- prlimit ... -- ffprobe` with no shell and an ignored stdin', () => {
    linuxHostWithNamespaces();
    probeInput(mediaFile, FFPROBE);

    const [spawn] = ffprobeSpawns();
    expect(ffprobeSpawns()).toHaveLength(1);
    expect(spawn.file).toBe(UNSHARE);
    expect(spawn.args.slice(0, 3)).toEqual(['-r', '-n', '--']);
    expect(spawn.args[3]).toBe(PRLIMIT);
    const afterPrlimit = spawn.args.indexOf('--', 4);
    expect(afterPrlimit).toBeGreaterThan(3);
    expect(spawn.args.slice(afterPrlimit + 1)).toEqual([
      FFPROBE, '-v', 'error', '-show_streams', '-show_entries', 'format=start_time,duration:chapter=id', '-of', 'json', mediaFile,
    ]);
    expect(spawn.options.shell ?? false).toBe(false);
    expect((spawn.options.stdio as unknown[])[0]).toBe('ignore');
  });

  it('caps address space, CPU time, file size and open files of the probe', () => {
    linuxHostWithNamespaces();
    probeInput(mediaFile, FFPROBE);

    const limits = ffprobeSpawns()[0].args.slice(4, ffprobeSpawns()[0].args.indexOf('--', 4));
    const byName = Object.fromEntries(limits.map((flag) => flag.replace(/^--/, '').split('=')));
    expect(Object.keys(byName).sort()).toEqual(['as', 'cpu', 'fsize', 'nofile']);
    expect(Number(byName.as)).toBeGreaterThanOrEqual(BYTES_PER_MB * 1024);
    expect(Number(byName.as)).toBeLessThanOrEqual(BYTES_PER_MB * 8 * 1024);
    expect(Number(byName.cpu)).toBeGreaterThan(0);
    expect(Number(byName.cpu)).toBeLessThanOrEqual(10);
    expect(Number(byName.fsize)).toBeLessThanOrEqual(BYTES_PER_MB);
    expect(Number(byName.nofile)).toBeLessThanOrEqual(1024);
  });

  it('bounds the JSON report at the size limit and the run at its timeout', () => {
    linuxHostWithNamespaces();
    probeInput(mediaFile, FFPROBE);

    const { options } = ffprobeSpawns()[0];
    expect(options.maxBuffer).toBe(MAX_JSON_BYTES);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(10_000);
  });

  it('starts the scalar probes of the argument builders under the same wrapper', () => {
    linuxHostWithNamespaces();
    host.stdout = '2\n';
    expect(probeAudioChannels(mediaFile, FFPROBE)).toBe(2);
    host.stdout = '44100\n';
    expect(probeAudioSampleRate(mediaFile, FFPROBE)).toBe(44100);
    host.stdout = '0\n1\n';
    expect(probeAudioStreamCount(mediaFile, FFPROBE)).toBe(2);
    host.stdout = '12.5\n';
    expect(probeInputDuration(mediaFile, FFPROBE)).toBe(12.5);

    const probes = ffprobeSpawns();
    expect(probes).toHaveLength(4);
    for (const probe of probes) {
      expect(probe.file).toBe(UNSHARE);
      expect(probe.args.slice(0, 3)).toEqual(['-r', '-n', '--']);
      expect(probe.args).toContain(FFPROBE);
      expect(probe.args[probe.args.length - 1]).toBe(mediaFile);
    }
  });

  it('starts the HDR light-level probe under the wrapper as well', () => {
    linuxHostWithNamespaces();
    host.stdout = '1000\n';
    expect(probeVideoMaxLightLevel(mediaFile, FFPROBE)).toBe(1000);

    const [probe] = ffprobeSpawns();
    expect(probe.file).toBe(UNSHARE);
    expect(probe.args.slice(0, 3)).toEqual(['-r', '-n', '--']);
    expect(probe.args).toContain(FFPROBE);
  });

  it('runs with a sanitized environment: no credentials, proxies poisoned, no inherited variables', () => {
    linuxHostWithNamespaces();
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'leak-me');
    vi.stubEnv('DATABASE_URL', 'postgres://leak-me');
    vi.stubEnv('SESSION_TOKEN', 'leak-me');
    vi.stubEnv('SOME_UNRELATED_SETTING', 'leak-me');
    probeInput(mediaFile, FFPROBE);

    const env = ffprobeSpawns()[0].options.env as Record<string, string>;
    expect(JSON.stringify(env)).not.toContain('leak-me');
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:0');
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:0');
    expect(env.PATH).toBeTruthy();
  });
});

describe('a command with only an open-file limit', () => {
  it('is wrapped in prlimit', () => {
    linuxHostWithNamespaces();
    const resolved = resolveSandboxedCommand('/opt/test-tools/tool', ['x'], { networkIsolated: false, rlimits: { nofile: 64 } });
    expect(resolved).toEqual({ binary: PRLIMIT, args: ['--nofile=64', '--', '/opt/test-tools/tool', 'x'], wrapped: true });
  });
});

describe('ffprobe under STRICT_SANDBOX when the sandbox is unavailable', () => {
  it('refuses every probe with a SandboxUnavailableError and starts nothing', () => {
    sandboxDenied();
    const probes: Array<() => unknown> = [
      () => probeInput(mediaFile, FFPROBE),
      () => probeAudioChannels(mediaFile, FFPROBE),
      () => probeAudioSampleRate(mediaFile, FFPROBE),
      () => probeAudioStreamCount(mediaFile, FFPROBE),
      () => probeInputDuration(mediaFile, FFPROBE),
      () => probeVideoMaxLightLevel(mediaFile, FFPROBE),
    ];
    for (const probe of probes) {
      expect(probe).toThrow(SandboxUnavailableError);
    }
    expect(host.spawns).toEqual([]);
  });

  it('does not turn the refusal into "the duration is unknown" in the duration check of a conversion', () => {
    sandboxDenied();
    expect(() => probeMediaDuration(mediaFile, {}, FFPROBE)).toThrow(SandboxUnavailableError);
    expect(host.spawns).toEqual([]);
  });

  it('rejects a media conversion before any native tool is started', async () => {
    sandboxDenied();
    // Real files, so the engine resolves them; the spawn mock records a start instead of running them.
    const ffmpeg = path.join(workDir, 'ffmpeg');
    const ffprobe = path.join(workDir, 'ffprobe');
    for (const tool of [ffmpeg, ffprobe]) {
      writeFileSync(tool, '#!/bin/sh\nexit 3\n');
      chmodSync(tool, 0o755);
    }
    vi.stubEnv('FFMPEG_PATH', ffmpeg);
    vi.stubEnv('FFPROBE_PATH', ffprobe);
    const run = dispatchConversion(OPAQUE_MEDIA, 'mp3', 'ogg', {}, 'input.mp3');
    await expect(run).rejects.toBeInstanceOf(SandboxUnavailableError);
    expect(host.spawns.filter((spawn) => /ffmpeg|ffprobe/.test(spawn.file))).toEqual([]);
  });

  it('refuses to probe without resource limits when prlimit is missing, instead of running ffprobe unlimited', () => {
    linuxHostWithNamespaces();
    host.prlimitInstalled = false;
    expect(() => probeInput(mediaFile, FFPROBE)).toThrow(SandboxUnavailableError);
    expect(() => probeAudioChannels(mediaFile, FFPROBE)).toThrow(/prlimit/);
    expect(host.spawns).toEqual([]);
  });

  it('still probes without prlimit when the sandbox is not strict, as other tools do on a development host', () => {
    stubPlatform('linux');
    host.linuxHost = true;
    host.prlimitInstalled = false;
    probeInput(mediaFile, FFPROBE);
    const [spawn] = ffprobeSpawns();
    expect(spawn.file).toBe(UNSHARE);
    expect(spawn.args).not.toContain(PRLIMIT);
  });

  it('only refuses under STRICT_SANDBOX: a development host without namespaces still probes', () => {
    stubPlatform('linux');
    host.linuxHost = false;
    probeInput(mediaFile, FFPROBE);
    expect(ffprobeSpawns().map((spawn) => spawn.file)).toEqual([FFPROBE]);
  });
});
