import { chmodSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FfprobePath, probeInput, probeInputAsync, resetInputProbeCache } from '../src/lib/conversions/media-ffprobe';
import { openMediaInput, runFfprobe, runFfprobeAsync } from '../src/lib/conversions/media-process';
import * as sandbox from '../src/lib/security/process-sandbox';

/**
 * ffprobe reads every upload before FFmpeg does. It runs in the namespace sandbox with an address space, a file size, a CPU time and no
 * core file, and the probe of a conversion is asked without holding the event loop: the process runs beside it, and the signal of the job
 * ends it. The ffprobe here is a script that logs its starts and answers (or waits) as told, so what is read is what the sandbox was asked.
 */

vi.mock('../src/lib/security/process-sandbox', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/security/process-sandbox')>();
  return { ...original, executeSandboxedBinary: vi.fn(original.executeSandboxedBinary), resolveSandboxedCommand: vi.fn(original.resolveSandboxedCommand) };
});

const SAMPLE_MP4_PATH = path.resolve(__dirname, 'fixtures', 'sample.mp4');
const GIB = 1024 * 1024 * 1024;
const SPY_MODE = 0o755;
const PROBE_JSON = '{"streams":[{"index":0,"codec_type":"audio","codec_name":"aac","sample_rate":"44100","channels":2}],"format":{"start_time":"0.0","duration":"3.5"}}';

let dir = '';
let log = '';
let ffprobe = '' as FfprobePath;

/** Writes an ffprobe that logs each start and then runs `body` (a shell fragment). */
function writeProbe(body: string): void {
  writeFileSync(ffprobe, `#!/bin/sh\necho start >> "${log}"\n${body}\n`);
  chmodSync(ffprobe, SPY_MODE);
}
const starts = (): number => (existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean).length : 0);

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'easyconvert-ffprobe-async-'));
  log = path.join(dir, 'starts.log');
  ffprobe = path.join(dir, 'ffprobe') as FfprobePath;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(log, { force: true });
  resetInputProbeCache();
  vi.mocked(sandbox.executeSandboxedBinary).mockClear();
  vi.mocked(sandbox.resolveSandboxedCommand).mockClear();
});
afterEach(() => vi.unstubAllEnvs());

const media = () => openMediaInput(SAMPLE_MP4_PATH, 'mp4');

describe('the limits of an ffprobe run', () => {
  it('asks for an address space, a file size, a CPU time and no core file, asynchronously and synchronously', async () => {
    writeProbe(`echo '${PROBE_JSON}'`);
    await runFfprobeAsync(ffprobe, ['-v', 'error'], media(), { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
    const asked = vi.mocked(sandbox.executeSandboxedBinary).mock.calls[0][2];
    expect(asked).toMatchObject({ networkIsolated: true, timeoutMs: 10_000, rlimits: { asBytes: 2 * GIB, fsizeBytes: 1024 * 1024, cpuSeconds: 12, coreBytes: 0 } });
    runFfprobe(ffprobe, ['-v', 'error'], media(), { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
    const resolved = vi.mocked(sandbox.resolveSandboxedCommand).mock.calls.at(-1)![2] as { rlimits?: unknown; networkIsolated?: boolean };
    expect(resolved).toMatchObject({ networkIsolated: true, rlimits: { asBytes: 2 * GIB, fsizeBytes: 1024 * 1024, cpuSeconds: 12, coreBytes: 0 } });
  });

  it('answers a failed run as a value with the words of ffprobe, and a missing sandbox as an error', async () => {
    writeProbe('echo "moov atom not found" >&2; exit 1');
    const failed = await runFfprobeAsync(ffprobe, ['-v', 'error'], media(), { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
    expect(failed).toMatchObject({ ok: false, failure: 'moov atom not found' });
    vi.stubEnv('STRICT_SANDBOX', 'true');
    vi.mocked(sandbox.executeSandboxedBinary).mockRejectedValueOnce(sandbox.sandboxUnavailable('no namespaces'));
    await expect(runFfprobeAsync(ffprobe, ['-v', 'error'], media(), { timeoutMs: 10_000, maxBuffer: 1024 * 1024 })).rejects.toThrow('no namespaces');
  });
});

describe('probeInputAsync', () => {
  it('leaves the event loop running while ffprobe runs', async () => {
    writeProbe(`sleep 0.4; echo '${PROBE_JSON}'`);
    let ticks = 0;
    const timer = setInterval(() => (ticks += 1), 20);
    try {
      const probe = await probeInputAsync(media(), ffprobe);
      expect(probe.durationSec).toBe(3.5);
    } finally {
      clearInterval(timer);
    }
    // A run that held the loop for 400 ms would let none of the ticks of 20 ms through.
    expect(ticks).toBeGreaterThan(8);
  });

  it('is remembered for the probeInput that follows, which starts no process', async () => {
    writeProbe(`echo '${PROBE_JSON}'`);
    const input = media();
    const first = await probeInputAsync(input, ffprobe);
    expect(starts()).toBe(1);
    expect(probeInput(input, ffprobe)).toBe(first);
    expect(await probeInputAsync(input, ffprobe)).toBe(first);
    expect(starts()).toBe(1);
  });

  it('hands its failure to the probeInput that follows once, instead of running the failed probe again', async () => {
    writeProbe('echo "Invalid data found" >&2; exit 1');
    const input = media();
    const failure = await probeInputAsync(input, ffprobe).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    // The probe, and the run that looks for the reason the codec is missing (media-decode-failures), which is made when the probe fails.
    const afterAsync = starts();
    expect(afterAsync).toBeGreaterThanOrEqual(1);
    expect(() => probeInput(input, ffprobe)).toThrow((failure as Error).message);
    expect(starts()).toBe(afterAsync);
    // Once: the next ask runs the probe.
    expect(() => probeInput(input, ffprobe)).toThrow();
    expect(starts()).toBeGreaterThan(afterAsync);
  });

  it('keeps the failures nobody asked for in a bounded list, oldest first, and drops the ones that expired', async () => {
    writeProbe('echo "Invalid data found" >&2; exit 1');
    const files = Array.from({ length: 20 }, (_, index) => {
      const file = path.join(dir, `clip-${index}.mp4`);
      writeFileSync(file, readFileSync(SAMPLE_MP4_PATH));
      return openMediaInput(file, 'mp4');
    });
    for (const input of files) await probeInputAsync(input, ffprobe).catch(() => undefined);
    const before = starts();
    // The newest failures are still handed on (no process); the oldest were evicted, so asking for one runs the probe again.
    expect(() => probeInput(files[19], ffprobe)).toThrow();
    expect(starts()).toBe(before);
    expect(() => probeInput(files[0], ffprobe)).toThrow();
    expect(starts()).toBeGreaterThan(before);
  });

  /** Well under the 30 s the stand-in probe sleeps, and the floor of a hang guard on a loaded runner. */
  const PROBE_HANG_GUARD_MS = 10_000;
  it('is ended by the signal of the job, with its reason, and leaves nothing to hand on', async () => {
    writeProbe('sleep 30');
    const controller = new AbortController();
    const started = Date.now();
    const probing = probeInputAsync(media(), ffprobe, controller.signal);
    setTimeout(() => controller.abort(new Error('job cancelled')), 100);
    await expect(probing).rejects.toThrow('job cancelled');
    // The probe sleeps 30 s; ending far below that shows the signal ended it.
    expect(Date.now() - started).toBeLessThan(PROBE_HANG_GUARD_MS);
    writeProbe(`echo '${PROBE_JSON}'`);
    expect(probeInput(media(), ffprobe).durationSec).toBe(3.5);
  });
});
