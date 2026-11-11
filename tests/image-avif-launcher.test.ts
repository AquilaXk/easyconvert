import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { sandboxLauncherState, startSandboxLauncher, stopSandboxLauncher } from '../src/lib/security/sandbox-launcher';
import { ConversionFailedError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { interface16 } from './helpers/graphic-parity';
import { ancestorsOf, processesWithArgument } from './helpers/process-state';
import { skipWithoutTools } from './helpers/strict-skip';
import { runWithoutFileConfinement } from './helpers/unconfined-files';

// The stand-in programs of this suite write their records outside the job directory, which the file confinement refuses (policy 232).
runWithoutFileConfinement();

/**
 * The AVIF command-line encoder started from the launcher helper (src/lib/security/sandbox-launcher.ts), which is what a worker of a few
 * hundred megabytes does: a fork of such a process costs more than the helper's round trip. The process reports a large resident size so that
 * the helper is judged worth it. The file the encoder writes is compared with the one the same conversion writes with the helper turned off, and
 * a wrapper in place of the encoder records what it was run with, so the checks do not rest on the product's own view of what it started.
 */

const LARGE_WORKER_BYTES = 1024 * 1024 * 1024;
const SCRIPT_MODE = 0o755;
const CONVERSION_TIMEOUT_MS = 60_000;
/** The wrapper gives up waiting for its release after this many polls of 50 ms (20 s), whatever the test does. */
const WRAPPER_WAIT_POLLS = 400;
const WRAPPER_START_HANG_GUARD_MS = 20_000;
const WRAPPER_POLL_MS = 25;
const toolsMissing = skipWithoutTools('avifenc');

let workDir: string;
const savedAvifencPath = process.env.AVIFENC_PATH;
const savedLauncher = process.env.SANDBOX_LAUNCHER;
const savedTmpdir = process.env.TMPDIR;

beforeAll(async () => {
  workDir = mkdtempSync(path.join(os.tmpdir(), 'avif-launcher-'));
  if (toolsMissing) return;
  vi.spyOn(process.memoryUsage, 'rss').mockReturnValue(LARGE_WORKER_BYTES);
  expect(await startSandboxLauncher()).toBe(true);
}, 60_000);

afterEach(() => {
  restore('AVIFENC_PATH', savedAvifencPath);
  restore('SANDBOX_LAUNCHER', savedLauncher);
  restore('TMPDIR', savedTmpdir);
});

afterAll(() => {
  vi.restoreAllMocks();
  stopSandboxLauncher();
  rmSync(workDir, { recursive: true, force: true });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A stand-in for the encoder that leaves its parent process id and its working directory on record, then runs the real encoder. */
function recordingWrapper(name: string, tail = ''): { script: string; record: string } {
  const script = path.join(workDir, name);
  const record = path.join(workDir, `${name}.record`);
  const real = requireOracleTool('avifenc');
  writeFileSync(
    script,
    `#!/bin/sh\n[ "$1" = "--version" ] && exec '${real}' "$@"\nprintf '%s %s\\n' "$PPID" "$(pwd)" >> '${record}'\n${tail}\nexec '${real}' "$@"\n`
  );
  chmodSync(script, SCRIPT_MODE);
  return { script, record };
}

const launchedPrograms = (): number => sandboxLauncherState().launched;

describe.skipIf(toolsMissing)('the AVIF encoder through the launcher helper', () => {
  it('is started by the helper, and writes the file it writes when the process starts it itself', async () => {
    const source = await interface16();
    // The wrapper waits for a file while this test looks at its place in the process tree: the sandbox may put the program in a PID namespace, where the
    // parent it reads for itself is not the helper, so the parent is read from the host's view of the running wrapper.
    const release = path.join(workDir, 'records-parent.release');
    const wrapper = recordingWrapper('records-parent', `n=0\nwhile [ ! -e '${release}' ] && [ $n -lt ${WRAPPER_WAIT_POLLS} ]; do sleep 0.05; n=$((n+1)); done`);
    process.env.AVIFENC_PATH = wrapper.script;

    const before = launchedPrograms();
    const converting = convertImage(source, 'avif', { quality: 60 }, 'ui.png', 'png');
    // The wrapper writes its record after the version probe, which the worker itself runs first (and which has the wrapper's path in its command line too).
    const recordDeadline = Date.now() + WRAPPER_START_HANG_GUARD_MS;
    while (!existsSync(wrapper.record) && Date.now() < recordDeadline) await new Promise((resolve) => setTimeout(resolve, WRAPPER_POLL_MS));
    expect(existsSync(wrapper.record), 'the encoder started').toBe(true);
    const helper = sandboxLauncherState().pid;
    const encoders = processesWithArgument(wrapper.script);
    expect(encoders, 'the encoder is running').not.toEqual([]);
    const owners = encoders.map((encoder) => ancestorsOf(encoder).find((pid) => pid === helper || pid === process.pid));
    writeFileSync(release, '');
    const viaHelper = await converting;
    expect(launchedPrograms() - before, 'the encoder was started by the helper').toBe(1);
    expect(owners, 'every process of the run stands below the helper, not directly below this process').toEqual(encoders.map(() => helper));

    process.env.SANDBOX_LAUNCHER = 'off';
    const direct = await convertImage(source, 'avif', { quality: 60 }, 'ui.png', 'png');
    expect(viaHelper.metadata).toMatchObject({ avifEncoder: 'library-cli' });
    expect(viaHelper.buffer.equals(direct.buffer)).toBe(true);
  }, CONVERSION_TIMEOUT_MS);

  it('keeps the working directory private to the run and removes it', async () => {
    const tmp = realpathSync(mkdtempSync(path.join(workDir, 'tmp-')));
    process.env.TMPDIR = tmp;
    const wrapper = recordingWrapper('records-directory');
    process.env.AVIFENC_PATH = wrapper.script;

    await convertImage(await interface16(), 'avif', { quality: 60 }, 'ui.png', 'png');

    const [, jobDir] = readFileSync(wrapper.record, 'utf-8').trim().split(' ');
    expect(path.dirname(jobDir)).toBe(tmp);
    expect(existsSync(jobDir)).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  }, CONVERSION_TIMEOUT_MS);

  it('an encoder that fails is the typed error of the conversion, as when the process starts it', async () => {
    const failing = recordingWrapper('always-fails', 'exit 3');
    process.env.AVIFENC_PATH = failing.script;
    const before = launchedPrograms();

    const failure = await convertImage(await interface16(), 'avif', {}, 'ui.png', 'png').then(
      () => null,
      (err: unknown) => err
    );

    expect(launchedPrograms() - before).toBeGreaterThanOrEqual(1);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toMatch(/the AVIF encoder failed on the picture/);
  }, CONVERSION_TIMEOUT_MS);
});
