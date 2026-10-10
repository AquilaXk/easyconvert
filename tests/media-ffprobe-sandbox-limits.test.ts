import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  probeAudioChannels,
  probeInput,
  resetInputProbeCache,
  type FfprobePath,
} from '../src/lib/conversions/media-ffprobe';
import { JOB_DEADLINE_AT } from '../src/lib/conversions/job-time';
import { getUnshareCapability } from '../src/lib/security/process-sandbox';
import { ConversionFailedError } from '../src/lib/types';
import { skipUnless } from './helpers/strict-skip';

/**
 * The runtime limits of the sandboxed ffprobe, observed on real processes: spy binaries stand in for ffprobe and
 * record how they were started, flood stdout, or hang.
 */

const SPY_MODE = 0o755;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const HANG_SECONDS = 30;
const DEADLINE_MS = 300;
/** A probe cut at a 300 ms deadline returns long before the 30 s the spy would otherwise run. */
const PROMPT_RETURN_MS = 5_000;
const OPAQUE_MEDIA = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000'.padEnd(512, '\u0000'), 'latin1');
const HAS_NAMESPACES = getUnshareCapability().available;

let workDir = '';
let mediaFile = '';
let log = '';

function spy(name: string, body: string): FfprobePath {
  const file = path.join(workDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, SPY_MODE);
  return file as FfprobePath;
}

function started(): string[] {
  return existsSync(log) ? readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [];
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'ffprobe-sandbox-limits-'));
  mediaFile = path.join(workDir, 'input.mp3');
  writeFileSync(mediaFile, OPAQUE_MEDIA);
  log = path.join(workDir, 'started.log');
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(log, { force: true });
  resetInputProbeCache();
});

describe('the JSON report of ffprobe', () => {
  it('is refused past the size limit, and the flooding process is stopped', () => {
    // 6 MiB of JSON-looking output, more than the 4 MiB a 64-stream report with long tags stays under.
    const flood = spy('flood-json', `echo started >> '${log}'\nexec head -c ${MAX_JSON_BYTES + 2 * 1024 * 1024} /dev/zero`);
    let failure: unknown;
    try {
      probeInput(mediaFile, flood);
    } catch (err) {
      failure = err;
    }
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/^ffprobe could not inspect the input media/);
    expect(started()).toEqual(['started']);
  });

  it('is accepted just under the limit', () => {
    const body = JSON.stringify({ streams: [{ index: 0, codec_type: 'audio', codec_name: 'mp3', tags: { title: 'x'.repeat(MAX_JSON_BYTES - 1024) } }] });
    const payload = path.join(workDir, 'big.json');
    writeFileSync(payload, body);
    const big = spy('big-json', `exec cat '${payload}'`);
    const probe = probeInput(mediaFile, big);
    expect(probe.streams.map((stream) => stream.codecName)).toEqual(['mp3']);
    expect(probe.streams[0].title).toHaveLength(MAX_JSON_BYTES - 1024);
  });

  it('is not parsed when the probe exits with an error, whatever it printed first', () => {
    const failing = spy('failing', `echo '{"streams":[]}'\nexit 1`);
    expect(() => probeInput(mediaFile, failing)).toThrow(ConversionFailedError);
  });
});

describe('the job limits reach the probe', () => {
  it('starts no process when the job was already aborted, and rethrows the abort reason', () => {
    const never = spy('never-started', `echo started >> '${log}'\nexec sleep ${HANG_SECONDS}`);
    const reason = new Error('client went away');
    const signal = AbortSignal.abort(reason);
    expect(() => probeInput(mediaFile, never, { signal })).toThrow(reason);
    expect(() => probeAudioChannels(mediaFile, never, 0, { signal })).toThrow(reason);
    expect(started()).toEqual([]);
  });

  it('stops a hanging probe at the time the job has left, not at the 10 s probe limit', () => {
    const hanging = spy('hanging', `echo started >> '${log}'\nexec sleep ${HANG_SECONDS}`);
    const begun = Date.now();
    expect(() => probeInput(mediaFile, hanging, { [JOB_DEADLINE_AT]: Date.now() + DEADLINE_MS })).toThrow(ConversionFailedError);
    expect(Date.now() - begun).toBeLessThan(PROMPT_RETURN_MS);
    expect(started()).toEqual(['started']);
  });
});

// skip-ok: the namespaces the sandbox asks for need a Linux kernel that grants unprivileged user and network namespaces.
describe.skipIf(skipUnless('unprivileged namespaces (unshare -r -n)', HAS_NAMESPACES))('ffprobe in strict mode on a Linux host', () => {
  it('starts in a new user and network namespace: the spy sees neither the worker network nor its uid', () => {
    vi.stubEnv('STRICT_SANDBOX', 'true');
    try {
      const seen = (name: string) => path.join(workDir, `seen-${name}`);
      const inspector = spy(
        'ns-ffprobe',
        [
          `readlink /proc/self/ns/net > '${seen('net')}'`,
          `cat /proc/self/uid_map > '${seen('uid')}'`,
          `cat /proc/net/dev > '${seen('dev')}'`,
          `echo '{"streams":[{"index":0,"codec_type":"audio","codec_name":"mp3"}]}'`,
        ].join('\n')
      );
      probeInput(mediaFile, inspector);
      expect(readFileSync(seen('net'), 'utf-8').trim()).not.toBe(readlinkSync('/proc/self/ns/net'));
      expect(readFileSync(seen('uid'), 'utf-8').trim().split(/\s+/)).toEqual(['0', String(process.getuid?.() ?? 0), '1']);
      const devices = readFileSync(seen('dev'), 'utf-8')
        .split('\n')
        .slice(2)
        .filter((line) => line.includes(':'))
        .map((line) => line.split(':')[0].trim());
      expect(devices).toEqual(['lo']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
