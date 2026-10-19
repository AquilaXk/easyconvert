import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  encodeRun,
  launchQpdf,
  qpdfRunnerState,
  QPDF_RUNNER_ENV,
  QPDF_RUNNER_LIB_ENV,
  QPDF_RUNNER_PATH_ENV,
  startQpdfRunner,
  stopQpdfRunner,
} from '../src/lib/conversions/pdf-postprocess/qpdf-runner';
import { getSanitizedEnvironment, SandboxedBufferLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';

/**
 * The jobs of qpdf-runner, read through a stand-in for libqpdf (tests/helpers/qpdf-runner-probe.c) whose job entry reports what
 * the process it runs in is like: the namespaces, the limits, the memory it can see. Nothing here trusts the runner's word for
 * what it did; every property is read from /proc by the job itself or from outside by this test. The real library is exercised by
 * tests/qpdf-runner-qpdf.test.ts.
 */

const C_COMPILER = process.env.CC ?? 'cc';
const compilerMissing = skipUnless('a C compiler (cc)', spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0);
/** Whether this host lets an unprivileged process make the user and network namespace a job runs in; CI enables them. */
const canIsolate = process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;
const namespacesMissing = skipUnless('unprivileged user and network namespaces (unshare -r -n)', canIsolate);
const QPDF = '/usr/bin/qpdf';
const WAIT_STEP_MS = 25;
/** One byte past the largest frame the runner reads. */
const MAX_FRAME_PLUS_ONE = 4 * 1024 * 1024 + 1;

let scratch: string;
let runnerBinary: string;
let probeLibrary: string;
let denyBinary: string;

function compile(source: string, output: string, ...flags: string[]): void {
  execFileSync(C_COMPILER, ['-std=gnu11', '-O2', '-Wall', '-Wextra', ...flags, '-o', output, source, ...(flags.includes('-shared') ? [] : ['-ldl'])], { stdio: 'pipe' });
}

function facts(output: Buffer): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.toString('utf8').split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s+(.*)$/.exec(line);
    if (match && !map.has(match[1])) map.set(match[1], match[2]);
  }
  return map;
}

const run = (args: string[], options: Parameters<typeof launchQpdf>[2] = {}): ReturnType<typeof launchQpdf> =>
  launchQpdf(QPDF, args, { timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024, cwd: scratch, ...options });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time');
    await sleep(WAIT_STEP_MS); // NOSONAR S9382 polling
  }
}

/** The process ids of the children of `pid`. */
function childrenOf(pid: number): number[] {
  const out = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter(Boolean).map(Number);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'qpdf-runner-test-'));
  runnerBinary = path.join(scratch, 'qpdf-runner');
  probeLibrary = path.join(scratch, 'probe.so');
  denyBinary = path.join(scratch, 'seccomp-deny');
  execFileSync(path.join(process.cwd(), 'native', 'qpdf-runner', 'build.sh'), [runnerBinary], { stdio: 'pipe' });
  compile(path.join(process.cwd(), 'tests', 'helpers', 'qpdf-runner-probe.c'), probeLibrary, '-shared', '-fPIC');
  compile(path.join(process.cwd(), 'tests', 'helpers', 'seccomp-deny.c'), denyBinary);
  process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
  process.env[QPDF_RUNNER_LIB_ENV] = probeLibrary;
  delete process.env[QPDF_RUNNER_ENV];
}, 120_000);

afterAll(() => {
  stopQpdfRunner();
  delete process.env[QPDF_RUNNER_PATH_ENV];
  delete process.env[QPDF_RUNNER_LIB_ENV];
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(compilerMissing)('the qpdf runner', () => {
  it('builds with no warning and prints the version of the library it loads', () => {
    const build = spawnSync(path.join(process.cwd(), 'native', 'qpdf-runner', 'build.sh'), [path.join(scratch, 'second')], { encoding: 'utf8' });
    expect({ status: build.status, output: build.stderr + build.stdout }).toEqual({ status: 0, output: '' });
    const printed = spawnSync(runnerBinary, ['--check', '--lib', probeLibrary], { encoding: 'utf8' });
    expect({ status: printed.status, out: printed.stdout }).toEqual({ status: 0, out: 'probe\n' });
  });

  it('refuses to start with no library, a library with no job entry, and an argument it does not know', () => {
    const missing = spawnSync(runnerBinary, ['--check', '--lib', path.join(scratch, 'nothing.so')], { encoding: 'utf8' });
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain('cannot load libqpdf');
    const noEntry = spawnSync(runnerBinary, ['--check', '--lib', 'libm.so.6'], { encoding: 'utf8' });
    expect(noEntry.status).toBe(3);
    expect(spawnSync(runnerBinary, ['--nonsense'], { encoding: 'utf8' }).status).toBe(2);
  });

  describe.skipIf(namespacesMissing)('jobs', () => {
    beforeAll(async () => {
      expect(await startQpdfRunner()).toBe(true);
    }, 30_000);

    it('gives every job a user namespace and a network namespace of its own, with the loopback alone', async () => {
      const state = qpdfRunnerState();
      expect(state.version).toBe('probe');
      const namespaceOf = (output: Buffer, kind: 'user' | 'net'): string => new RegExp(`/proc/self/ns/${kind} -> (\\S+)`).exec(output.toString('utf8'))![1];
      const parents = {
        user: [fs.readlinkSync('/proc/self/ns/user'), fs.readlinkSync(`/proc/${state.pid}/ns/user`)],
        net: [fs.readlinkSync('/proc/self/ns/net'), fs.readlinkSync(`/proc/${state.pid}/ns/net`)],
      };
      const results = await Promise.all([run(['facts']), run(['facts']), run(['facts'])]);
      for (const kind of ['user', 'net'] as const) {
        const mine = results.map((result) => namespaceOf(result.stdout, kind));
        expect(new Set(mine).size, `${kind} namespaces of three jobs`).toBe(3);
        for (const parent of parents[kind]) expect(mine, `${kind} namespace shared with a process outside the jobs`).not.toContain(parent);
      }
      for (const result of results) {
        const text = result.stdout.toString('utf8');
        const interfaces = [...text.matchAll(/^\s*(\w+):(?:\s+\d+){16}\s*$/gm)].map((match) => match[1]);
        expect(interfaces).toEqual(['lo']);
        expect(text).toMatch(new RegExp(`^\\s*0\\s+${process.geteuid?.()}\\s+1$`, 'm'));
        expect(text).toContain('deny');
      }
    });

    it('starts the job the way the sandbox starts a program: own session, working directory, environment, no extra descriptors, limits', async () => {
      const state = qpdfRunnerState();
      const result = await run(['facts'], { env: { EXTRA_FOR_TEST: 'visible' }, memoryLimitMb: 512, maxFileSize: 123_456_789, rlimits: { cpuSeconds: 77 } });
      const job = facts(result.stdout);
      const pid = Number(job.get('pid'));
      expect(Number(job.get('ppid'))).toBe(state.pid);
      expect(Number(job.get('sid'))).toBe(pid);
      expect(Number(job.get('pgid'))).toBe(pid);
      expect(job.get('uid')).toBe('0');
      expect(job.get('cwd')).toBe(fs.realpathSync(scratch));
      expect(job.get('no_new_privs')).toBe('1');
      expect(job.get('dumpable')).toBe('0');
      expect(job.get('pdeathsig')).toBe('9');
      expect(job.get('open-fds-above-2')).toBe('0');
      const limits = result.stdout.toString('utf8');
      expect(limits).toMatch(/Max address space\s+536870912\s+536870912/);
      expect(limits).toMatch(/Max file size\s+123456789\s+123456789/);
      expect(limits).toMatch(/Max cpu time\s+77\s+77/);
      expect(limits).toMatch(/Max core file size\s+0\s+0/);
      const env = result.stdout.toString('utf8').split('\n').filter((line) => line.startsWith('env: ')).map((line) => line.slice(5)).sort();
      const expected = Object.entries(getSanitizedEnvironment({ EXTRA_FOR_TEST: 'visible' }, true)).map(([k, v]) => `${k}=${v}`).sort();
      expect(env).toEqual(expected);
    });

    it('hands standard input to the job', async () => {
      const result = await run(['echo-stdin'], { stdin: Buffer.from('through the pipe') });
      expect(result.stdout.toString('utf8')).toBe('through the pipe');
    });

    it('gives a job the seccomp filter of the process that started the runner, and nothing is added or removed', async () => {
      const ownFilter = /Seccomp:\s+(\d)/.exec(fs.readFileSync('/proc/self/status', 'utf8'))![1];
      const job = facts((await run(['facts'])).stdout);
      expect(job.get('Seccomp')).toBe(ownFilter);
    });

    it('lets no job see the memory or the output of another, or of the runner', async () => {
      const state = qpdfRunnerState();
      const secret = `secret-${crypto.randomBytes(12).toString('hex')}`;
      const holder = run(['hold-secret', secret, '2']);
      await until(() => childrenOf(state.pid!).length > 0);
      const [holderPid] = childrenOf(state.pid!);
      // A control: the scanner finds a string that is in the job's own environment as well as in its argument.
      const control = await run(['scan', secret], { env: { OWN_COPY: secret } });
      expect(control.stdout.toString('utf8')).toMatch(/copies-of-needle: [1-9]/);
      // Without the environment copy the argument is the only one the scanning job has: the holder's output and the frames of the runner are not in it.
      const scan = await run(['scan', secret]);
      expect(scan.stdout.toString('utf8')).toContain('copies-of-needle: 0');
      const sibling = await run(['read-mem-of', String(holderPid)]);
      expect(sibling.stdout.toString('utf8')).not.toContain('allowed');
      const runnerMemory = await run(['read-mem-of', String(state.pid)]);
      expect(runnerMemory.stdout.toString('utf8')).not.toContain('allowed');
      expect((await holder).stdout.toString('utf8')).toBe(`secret=${secret}\n`);
    }, 30_000);

    it('returns the bytes a job wrote, for outputs of many sizes on both streams', async () => {
      for (const size of [0, 1, 4095, 4096, 65_536, 65_537, 5 * 1024 * 1024]) {
        const out = await run(['spam', String(size)]);
        expect(out.stdout.length).toBe(size);
        expect(out.stdout.equals(Buffer.alloc(size, 'x'))).toBe(true);
        const err = await run(['spam', String(size), 'e']);
        expect(err.stderr.length).toBe(size);
      }
    }, 60_000);

    it('reports a job that fails with its status and standard error, and one that crashes with its signal', async () => {
      const failure = (await run(['exit', '3']).catch((e: unknown) => e)) as SandboxedProcessError;
      expect(failure).toBeInstanceOf(SandboxedProcessError);
      expect({ code: failure.exitCode, stderr: failure.stderr, message: failure.message }).toEqual({ code: 3, stderr: 'probe failed on purpose\n', message: 'probe failed on purpose' });
      const crash = (await run(['crash']).catch((e: unknown) => e)) as SandboxedProcessError;
      expect(crash).toBeInstanceOf(SandboxedProcessError);
      expect({ code: crash.exitCode, signal: crash.signal }).toEqual({ code: null, signal: 'SIGABRT' });
      expect(crash.message).toBe('Process terminated by signal SIGABRT');
    });

    it('stops a job at its time limit with the typed error, and nothing of it is left', async () => {
      const state = qpdfRunnerState();
      const started = Date.now();
      const error = await run(['sleep', '30'], { timeoutMs: 300 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxedTimeoutError);
      expect(Date.now() - started).toBeLessThan(5000);
      await until(() => childrenOf(state.pid!).length === 0);
    });

    it('stops a job whose output passes the limit, standard output and error counted together', async () => {
      const error = (await run(['spam', '2000000'], { maxBuffer: 100_000 }).catch((e: unknown) => e)) as SandboxedBufferLimitError;
      expect(error).toBeInstanceOf(SandboxedBufferLimitError);
      expect(error.limitBytes).toBe(100_000);
      const both = await run(['spam', '60000', 'e'], { maxBuffer: 100_000 });
      expect(both.stderr.length).toBe(60_000);
    });

    it('stops a job that writes a file past its size limit', async () => {
      const error = await run(['write-file', path.join(scratch, 'big.bin'), '1000'], { maxFileSize: 100_000 }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxedBufferLimitError);
      expect((error as SandboxedBufferLimitError).limitBytes).toBe(100_000);
    });

    it('kills the job and rejects with the reason when the caller aborts', async () => {
      const state = qpdfRunnerState();
      const controller = new AbortController();
      const running = run(['sleep', '30'], { signal: controller.signal });
      running.catch(() => undefined);
      await until(() => childrenOf(state.pid!).length > 0);
      controller.abort(new Error('job cancelled'));
      await expect(running).rejects.toThrow('job cancelled');
      await until(() => childrenOf(state.pid!).length === 0);
      await expect(run(['facts'], { signal: AbortSignal.abort(new Error('already cancelled')) })).rejects.toThrow();
    });

    it('serves jobs that overlap, each with its own output', async () => {
      const payloads = Array.from({ length: 40 }, (_, index) => Buffer.from(`job-${index}-${crypto.randomBytes(8).toString('hex')}`));
      const results = await Promise.all(payloads.map((payload) => run(['echo-stdin'], { stdin: payload })));
      expect(results.map((result) => result.stdout.toString('utf8'))).toEqual(payloads.map((payload) => payload.toString('utf8')));
    });

    it('declines a job past its limit of 64 at a time, and a request for more output than it carries, and the usual way answers', async () => {
      const state = qpdfRunnerState();
      const holders = Array.from({ length: 64 }, () => run(['sleep', '2']));
      await until(() => childrenOf(state.pid!).length === 64);
      const before = qpdfRunnerState();
      const declined = await run(['facts']).catch((e: unknown) => e);
      // The usual way runs the real qpdf with these arguments, which fails: the runner did not run it.
      expect(declined).toBeInstanceOf(SandboxedProcessError);
      expect(qpdfRunnerState().fallbacks - before.fallbacks).toBe(1);
      expect(qpdfRunnerState().ran - before.ran).toBe(0);
      await Promise.all(holders);
      const huge = await run(['--version'], { maxBuffer: 2 * 1024 * 1024 * 1024 });
      expect(huge.stdout.toString('utf8')).toContain('qpdf version');
    }, 30_000);

    it('takes jobs again after one failed', async () => {
      await run(['exit', '2']).catch(() => undefined);
      expect((await run(['echo-stdin'], { stdin: Buffer.from('still up') })).stdout.toString('utf8')).toBe('still up');
    });

    it('ends its jobs when the runner is stopped, and when the runner is killed', async () => {
      const state = qpdfRunnerState();
      const running = run(['sleep', '30']);
      running.catch(() => undefined);
      await until(() => childrenOf(state.pid!).length > 0);
      const [jobPid] = childrenOf(state.pid!);
      process.kill(state.pid!, 'SIGKILL');
      await until(() => !alive(jobPid), 5000);
      await until(() => !qpdfRunnerState().ready);
      // A runner that ended by itself is not replaced at once; stopping resets the pause.
      expect(await startQpdfRunner()).toBe(false);
      stopQpdfRunner();
      expect(await startQpdfRunner()).toBe(true);
      const next = qpdfRunnerState();
      const sleeper = run(['sleep', '30']);
      sleeper.catch(() => undefined);
      await until(() => childrenOf(next.pid!).length > 0);
      const [pid] = childrenOf(next.pid!);
      stopQpdfRunner();
      await until(() => !alive(pid), 5000);
      expect(await startQpdfRunner()).toBe(true);
    }, 30_000);
  });

  describe('a job it declines or cannot isolate starts the usual way', () => {
    afterAll(() => {
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
      delete process.env[QPDF_RUNNER_ENV];
    });

    const usual = async (): Promise<string> => (await run(['--version'])).stdout.toString('utf8');

    it('runs jobs directly while the runner is off, missing or not up', async () => {
      stopQpdfRunner();
      process.env[QPDF_RUNNER_ENV] = 'off';
      const before = qpdfRunnerState().fallbacks;
      expect(await usual()).toContain('qpdf version');
      expect(await startQpdfRunner()).toBe(false);
      expect(qpdfRunnerState().fallbacks).toBeGreaterThan(before);
      delete process.env[QPDF_RUNNER_ENV];
      process.env[QPDF_RUNNER_PATH_ENV] = path.join(scratch, 'not-here');
      expect(await startQpdfRunner()).toBe(false);
      expect(await usual()).toContain('qpdf version');
    });

    it.skipIf(namespacesMissing)('declines a standard input past what the runner takes, and a program that is not qpdf', async () => {
      process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
      stopQpdfRunner();
      expect(await startQpdfRunner()).toBe(true);
      const ran = qpdfRunnerState().ran;
      const big = await launchQpdf('/bin/cat', [], { stdin: Buffer.alloc(40 * 1024, 'a'), cwd: scratch, timeoutMs: 20_000 });
      expect(big.stdout.length).toBe(40 * 1024);
      const notQpdf = await launchQpdf('/bin/echo', ['hello'], { cwd: scratch, timeoutMs: 20_000 });
      expect(notQpdf.stdout.toString('utf8')).toBe('hello\n');
      expect(qpdfRunnerState().ran).toBe(ran);
    });

    it.skipIf(namespacesMissing)('runs nothing of the job when the child cannot make its namespaces, and the usual way answers', async () => {
      const marker = path.join(scratch, 'ran-unisolated.marker');
      const denied = path.join(scratch, 'qpdf-runner-denied');
      fs.writeFileSync(denied, `#!/bin/sh\nexec ${denyBinary} unshare ${runnerBinary} "$@"\n`, { mode: 0o755 });
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = denied;
      expect(await startQpdfRunner()).toBe(true);
      const before = qpdfRunnerState();
      // The job would create the marker; the usual way runs the real qpdf with these arguments, which fails and creates nothing.
      const error = await run(['write-file', marker, '1']).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SandboxedProcessError);
      expect(fs.existsSync(marker)).toBe(false);
      const after = qpdfRunnerState();
      expect({ ran: after.ran - before.ran, fallbacks: after.fallbacks - before.fallbacks }).toEqual({ ran: 0, fallbacks: 1 });
      expect(await usual()).toContain('qpdf version');
    });

    it.skipIf(namespacesMissing)('gives a job the filter the runner runs under, and no other', async () => {
      const filtered = path.join(scratch, 'qpdf-runner-filtered');
      fs.writeFileSync(filtered, `#!/bin/sh\nexec ${denyBinary} mincore ${runnerBinary} "$@"\n`, { mode: 0o755 });
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = filtered;
      expect(await startQpdfRunner()).toBe(true);
      const job = facts((await run(['facts'])).stdout);
      expect(job.get('Seccomp')).toBe('2');
      expect((await run(['mincore'])).stdout.toString('utf8')).toContain('mincore: Operation not permitted');
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
      expect(await startQpdfRunner()).toBe(true);
      expect((await run(['mincore'])).stdout.toString('utf8')).not.toContain('Operation not permitted');
    });
  });

  describe('what the runner does with frames it cannot read', () => {
    /** Starts the runner on its own, writes the bytes, and reports how it ended. */
    function feed(bytes: Buffer, closeInput = true): Promise<{ status: number | null; signal: NodeJS.Signals | null; output: Buffer }> {
      return new Promise((resolve, reject) => {
        const child = spawn(runnerBinary, ['--lib', probeLibrary], { stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
        child.once('error', reject);
        child.once('exit', (status, signal) => resolve({ status, signal, output: Buffer.concat(chunks) }));
        child.stdin.on('error', () => undefined);
        child.stdin.write(bytes);
        if (closeInput) child.stdin.end();
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      });
    }

    const header = (length: number, type: number, id: number): Buffer => {
      const head = Buffer.alloc(9);
      head.writeUInt32BE(length, 0);
      head.writeUInt8(type, 4);
      head.writeUInt32BE(id, 5);
      return head;
    };

    it('ends with status 2 for a length that is too short or too long and for a type it does not know', async () => {
      for (const bytes of [header(4, 1, 1), header(0xffffffff, 1, 1), header(5, 99, 1), header(MAX_FRAME_PLUS_ONE, 1, 1)]) {
        const ended = await feed(bytes);
        expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 2, signal: null });
      }
    });

    it('ends quietly when its input closes in the middle of a frame or before any', async () => {
      for (const bytes of [Buffer.alloc(0), Buffer.from([0, 0]), header(100, 1, 1)]) {
        const ended = await feed(bytes);
        expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 0, signal: null });
      }
    });

    it('answers a request it cannot take with a refusal, and never dies of one', async () => {
      const relative = Buffer.concat(encodeRun(2, { timeoutMs: 1000, maxOutput: 1000, limitAsBytes: 0, limitFsizeBytes: 0, limitCpuSeconds: 0, cwd: 'relative', argv: ['qpdf'], env: [], stdin: Buffer.alloc(0) }));
      const noArguments = Buffer.concat(encodeRun(3, { timeoutMs: 1000, maxOutput: 1000, limitAsBytes: 0, limitFsizeBytes: 0, limitCpuSeconds: 0, cwd: '/tmp', argv: [], env: [], stdin: Buffer.alloc(0) }));
      const bigInput = Buffer.concat(encodeRun(4, { timeoutMs: 1000, maxOutput: 1000, limitAsBytes: 0, limitFsizeBytes: 0, limitCpuSeconds: 0, cwd: '/tmp', argv: ['qpdf'], env: [], stdin: Buffer.alloc(64 * 1024) }));
      const ended = await feed(Buffer.concat([relative, noArguments, bigInput]));
      expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 0, signal: null });
      // Three RESULT frames of kind 5 (rejected), in order.
      const kinds: number[] = [];
      for (let at = 0; at < ended.output.length; ) {
        const length = ended.output.readUInt32BE(at);
        const type = ended.output.readUInt8(at + 4);
        if (type === 11) kinds.push(ended.output.readUInt32BE(at + 9));
        at += 4 + length;
      }
      expect(kinds).toEqual([5, 5, 5]);
    });

    it('survives random bytes: it ends with status 0 or 2, never by a signal and never by hanging', async () => {
      for (let round = 0; round < 40; round++) {
        const bytes = crypto.randomBytes(1 + Math.floor(Math.random() * 600));
        const ended = await feed(bytes);
        expect(ended.signal, `round ${round}: ${bytes.toString('hex').slice(0, 80)}`).toBeNull();
        expect([0, 2]).toContain(ended.status);
      }
    }, 120_000);
  });
});

