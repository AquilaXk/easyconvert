import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  encodeRun,
  launchQpdf,
  processFailure,
  qpdfRunnerState,
  QPDF_RUNNER_ENV,
  QPDF_RUNNER_LIB_ENV,
  QPDF_RUNNER_PATH_ENV,
  ReplyReader,
  RunnerDeclined,
  startQpdfRunner,
  stopQpdfRunner,
} from '../src/lib/conversions/pdf-postprocess/qpdf-runner';
import { getSanitizedEnvironment, SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError, SandboxedTimeoutError } from '../src/lib/security/process-sandbox';
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

/** A request frame written field by field, with none of the checks `encodeRun` makes, for the refusals the runner must make on its own. */
function rawRun(id: number, fields: { cwd?: string; argv?: string[]; env?: string[]; stdin?: Buffer }): Buffer {
  const u32be = (value: number): Buffer => Buffer.from([value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
  const u64be = (value: number): Buffer => {
    const out = Buffer.alloc(8);
    out.writeBigUInt64BE(BigInt(value));
    return out;
  };
  const str = (value: string): Buffer => Buffer.concat([u32be(Buffer.byteLength(value)), Buffer.from(value)]);
  const argv = fields.argv ?? ['qpdf'];
  const env = fields.env ?? [];
  const stdin = fields.stdin ?? Buffer.alloc(0);
  const body = Buffer.concat([
    u32be(1000), // the time limit
    u64be(1000), // the output limit
    u64be(0), // the address-space limit
    u64be(0), // the file-size limit
    u32be(0), // the CPU limit
    str(fields.cwd ?? '/tmp'),
    u32be(argv.length),
    ...argv.map(str),
    u32be(env.length),
    ...env.map(str),
    u32be(stdin.length),
    stdin,
  ]);
  const head = Buffer.alloc(9);
  head.writeUInt32BE(5 + body.length, 0);
  head.writeUInt8(1, 4);
  head.writeUInt32BE(id, 5);
  return Buffer.concat([head, body]);
}

/** Whether the process runs: a zombie, which only waits for its parent to read its status, does not. */
const alive = (pid: number): boolean => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat[stat.lastIndexOf(')') + 2] !== 'Z';
  } catch {
    return false;
  }
};

const REQUEST = { timeoutMs: 1000, maxOutput: 1000, limitAsBytes: 0, limitFsizeBytes: 0, limitCpuSeconds: 0, cwd: '/tmp', argv: ['qpdf', 'echo-stdin'], env: ['A=1'], stdin: Buffer.alloc(0) };

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

describe('the reader of the runner\'s replies', () => {
  const replyFrame = (body: Buffer): Buffer => {
    const head = Buffer.alloc(9);
    head.writeUInt32BE(5 + body.length, 0);
    head.writeUInt8(11, 4);
    head.writeUInt32BE(7, 5);
    return Buffer.concat([head, body]);
  };

  it('copies a large reply once, however small the chunks it arrives in', () => {
    const body = Buffer.alloc(16 * 1024 * 1024);
    for (let at = 0; at < body.length; at += 4099) body[at] = at & 0xff;
    const wire = replyFrame(body);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const reader = new ReplyReader();
      const replies = [];
      for (let at = 0; at < wire.length; at += 64 * 1024) replies.push(...reader.push(wire.subarray(at, at + 64 * 1024)));
      const copied = concat.mock.results.reduce((sum, result) => sum + (result.value as Buffer).length, 0);
      expect(replies).toHaveLength(1);
      expect(replies[0].body.equals(body)).toBe(true);
      // The frame is joined once, when it is complete: not again for each of the 256 chunks.
      expect(copied).toBeLessThanOrEqual(2 * wire.length);
    } finally {
      concat.mockRestore();
    }
  });

  it('reads frames that arrive whole, several to a chunk, and split inside the length', () => {
    const frames = [Buffer.from('one'), Buffer.alloc(0), Buffer.from('three')].map(replyFrame);
    const wire = Buffer.concat(frames);
    for (const size of [1, 2, 3, 7, wire.length]) {
      const reader = new ReplyReader();
      const bodies: string[] = [];
      for (let at = 0; at < wire.length; at += size) bodies.push(...reader.push(wire.subarray(at, at + size)).map((reply) => reply.body.toString('utf8')));
      expect(bodies, `chunks of ${size}`).toEqual(['one', '', 'three']);
    }
  });

  it('refuses a length that no reply has', () => {
    expect(() => new ReplyReader().push(Buffer.from([0xff, 0xff, 0xff, 0xff, 11, 0, 0, 0, 1]))).toThrow('impossible length');
    expect(() => new ReplyReader().push(Buffer.from([0, 0, 0, 2, 11, 0, 0, 0, 1]))).toThrow('impossible length');
  });
});

describe('the failure of a job, as executeSandboxedBinary words it', () => {
  const SIGKILL = 9;
  const SIGSEGV = 11;
  const SIGABRT = 6;
  const failed = (signal: number, options: Parameters<typeof processFailure>[1]): Error =>
    processFailure({ kind: 5, exitStatus: 0, signal, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }, options);

  it.each([
    ['a fault', SIGSEGV, 'SIGSEGV'],
    ['a kill', SIGKILL, 'SIGKILL'],
  ])('names the signal on the memory limit error of %s under the address space limit', (_name, signal, name) => {
    const error = failed(signal, { memoryLimitMb: 2048 });
    expect(error).toBeInstanceOf(SandboxedMemoryLimitError);
    expect(error).toMatchObject({ limitMb: 2048, signal: name });
  });

  it('reads the limit from the rlimits when no memory limit is given, and keeps a crash that is not the limit as a process error', () => {
    expect(failed(SIGSEGV, { rlimits: { asBytes: 512 * 1024 * 1024 } })).toMatchObject({ name: 'SandboxedMemoryLimitError', limitMb: 512, signal: 'SIGSEGV' });
    const aborted = failed(SIGABRT, { memoryLimitMb: 2048 });
    expect(aborted).toBeInstanceOf(SandboxedProcessError);
    expect(aborted).toMatchObject({ signal: 'SIGABRT', exitCode: null });
    expect(failed(SIGSEGV, {})).toMatchObject({ name: 'SandboxedProcessError', signal: 'SIGSEGV' });
  });
});

describe('the frames the host writes', () => {
  it('are refused before they are sent when they are past what the runner takes, or hold a NUL', () => {
    const declined = (change: Partial<typeof REQUEST>): void => expect(() => encodeRun(1, { ...REQUEST, ...change })).toThrow(RunnerDeclined);
    declined({ argv: ['qpdf', 'a\0b'] });
    declined({ cwd: '/tmp/a\0b' });
    declined({ env: ['A=1\0B=2'] });
    declined({ cwd: 'relative' });
    declined({ argv: [] });
    declined({ argv: ['qpdf', 'x'.repeat(64 * 1024 + 1)] });
    declined({ argv: ['qpdf', 'é'.repeat(40_000)] }); // 80,000 bytes in 40,000 characters
    declined({ argv: Array.from({ length: 4097 }, () => 'a') });
    declined({ env: Array.from({ length: 4097 }, () => 'A=1') });
    declined({ argv: Array.from({ length: 70 }, () => 'y'.repeat(60 * 1024)) }); // past the frame limit as a whole
    declined({ stdin: Buffer.alloc(32 * 1024 + 1) });
    declined({ maxOutput: 0 });
    declined({ maxOutput: 2 * 1024 * 1024 * 1024 });
    expect(() => encodeRun(1, { ...REQUEST, argv: ['qpdf', 'x'.repeat(64 * 1024)], stdin: Buffer.alloc(32 * 1024) })).not.toThrow();
  });
});

describe.skipIf(compilerMissing)('the qpdf runner', () => {
  it('builds with no warning and prints the version of the library it loads', () => {
    const build = spawnSync(path.join(process.cwd(), 'native', 'qpdf-runner', 'build.sh'), [path.join(scratch, 'second')], { encoding: 'utf8' });
    expect({ status: build.status, output: build.stderr + build.stdout }).toEqual({ status: 0, output: '' });
    const printed = spawnSync(runnerBinary, ['--check', '--lib', probeLibrary], { encoding: 'utf8' });
    // The stand-in reports its own namespaces after its name, and the check runs in those of this process.
    const ownNamespaces = `user=${fs.readlinkSync('/proc/self/ns/user')} net=${fs.readlinkSync('/proc/self/ns/net')}`;
    expect({ status: printed.status, out: printed.stdout }).toEqual({ status: 0, out: `probe ${ownNamespaces}\n` });
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
      // The stand-in library reports the namespaces of the runner itself in its version: the test cannot read /proc/<runner>/ns, which only
      // a process allowed to trace the runner can (an unprivileged one is not: the runner does not allow it).
      expect(state.version).toMatch(/^probe user=user:\[\d+\] net=net:\[\d+\]$/);
      const runnerNamespaces = /^probe user=(\S+) net=(\S+)$/.exec(state.version)!;
      const namespaceOf = (output: Buffer, kind: 'user' | 'net'): string => new RegExp(`/proc/self/ns/${kind} -> (\\S+)`).exec(output.toString('utf8'))![1];
      const parents = {
        user: [fs.readlinkSync('/proc/self/ns/user'), runnerNamespaces[1]],
        net: [fs.readlinkSync('/proc/self/ns/net'), runnerNamespaces[2]],
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
      // The scanning job is given the secret in two halves and joins them in a buffer of its own, which the scan leaves out by its address: no
      // part of the job's arguments, environment or inherited memory holds the whole, so any other copy it finds is memory of the holder, of
      // another job or of the runner. A control: with the whole secret in the job's own environment the scan finds that copy.
      const [first, second] = [secret.slice(0, 7), secret.slice(7)];
      const control = await run(['scan-parts', first, second], { env: { OWN_COPY: secret } });
      expect(control.stdout.toString('utf8')).toMatch(/copies-of-needle: [1-9]/);
      const scan = await run(['scan-parts', first, second]);
      expect(scan.stdout.toString('utf8')).toBe('copies-of-needle: 0\n');
      // A page the scan cannot read (a file cut short) is passed over without a signal: a signal would leave the registers of the scan, which
      // hold the secret after a comparison, in a frame on the stack, and the scan would find that copy.
      const pastBadPage = await run(['scan-parts-past-a-bad-page', first, second]);
      expect(pastBadPage.stdout.toString('utf8')).toBe('copies-of-needle: 0\n');
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

    describe('a job whose first process returned and whose descendant is still running', () => {
      const pidOf = async (file: string): Promise<number> => {
        await until(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() !== '');
        return Number(fs.readFileSync(file, 'utf8'));
      };

      it('ends at the time limit of the job, the descendant killed with it, and other jobs go on', async () => {
        const pidFile = path.join(scratch, 'held-until-timeout.pid');
        const bystander = run(['sleep', '1']);
        const started = Date.now();
        // The first process returns 0 at once; its descendant keeps the standard streams of the job open for 30 seconds.
        const error = await run(['fork-sleep', pidFile, '30', 'hold'], { timeoutMs: 600 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(SandboxedTimeoutError);
        expect(Date.now() - started).toBeLessThan(4000);
        const descendant = await pidOf(pidFile);
        await until(() => !alive(descendant), 3000);
        expect((await bystander).stdout.toString('utf8')).toContain('sleeping');
        expect((await run(['echo-stdin'], { stdin: Buffer.from('still serving') })).stdout.toString('utf8')).toBe('still serving');
      }, 30_000);

      it('is stopped by the caller too: the abort kills the descendant', async () => {
        const pidFile = path.join(scratch, 'held-until-abort.pid');
        const controller = new AbortController();
        const running = run(['fork-sleep', pidFile, '30', 'hold'], { timeoutMs: 60_000, signal: controller.signal });
        running.catch(() => undefined);
        const descendant = await pidOf(pidFile);
        await sleep(200); // the first process has returned by now, and the job has not ended
        const started = Date.now();
        controller.abort(new Error('job cancelled'));
        await expect(running).rejects.toThrow('job cancelled');
        expect(Date.now() - started).toBeLessThan(2000);
        await until(() => !alive(descendant), 1000);
      }, 30_000);

      it('ends with the result of its first process once the streams stay open past the grace, and the descendant is killed', async () => {
        const pidFile = path.join(scratch, 'held-past-grace.pid');
        const started = Date.now();
        const result = await run(['fork-sleep', pidFile, '30', 'hold'], { timeoutMs: 20_000 });
        const waited = Date.now() - started;
        expect(result.exitCode).toBe(0);
        expect(waited).toBeGreaterThanOrEqual(900);
        expect(waited).toBeLessThan(4000);
        const descendant = await pidOf(pidFile);
        await until(() => !alive(descendant), 3000);
      }, 30_000);

      it('ends with the result of its first process when the descendant has closed the streams, and the descendant is killed', async () => {
        const pidFile = path.join(scratch, 'daemon.pid');
        const started = Date.now();
        const result = await run(['fork-sleep', pidFile, '30', 'daemon'], { timeoutMs: 20_000 });
        expect(result.exitCode).toBe(0);
        expect(Date.now() - started).toBeLessThan(4000);
        const descendant = await pidOf(pidFile);
        await until(() => !alive(descendant), 3000);
      }, 30_000);
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

    it.skipIf(namespacesMissing)('declines a standard input the pipe of the job cannot hold, instead of waiting for room, and keeps serving', async () => {
      // A host over its pipe budget gives a new pipe one page; a runner given pages of 4096 bytes is in that case.
      const small = path.join(scratch, 'qpdf-runner-small-pipe');
      fs.writeFileSync(small, `#!/bin/sh\nexec ${runnerBinary} --stdin-pipe-bytes 4096 "$@"\n`, { mode: 0o755 });
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = small;
      expect(await startQpdfRunner()).toBe(true);
      const before = qpdfRunnerState();
      const started = Date.now();
      const declined = await run(['echo-stdin'], { stdin: Buffer.alloc(20_000, 's') }).catch((e: unknown) => e);
      // The usual way runs the real qpdf with these arguments, which fails: the runner did not run the job, and did not wait.
      expect(declined).toBeInstanceOf(SandboxedProcessError);
      expect(Date.now() - started).toBeLessThan(3000);
      expect({ ran: qpdfRunnerState().ran - before.ran, fallbacks: qpdfRunnerState().fallbacks - before.fallbacks }).toEqual({ ran: 0, fallbacks: 1 });
      expect((await run(['echo-stdin'], { stdin: Buffer.from('small enough') })).stdout.toString('utf8')).toBe('small enough');
      expect(qpdfRunnerState().ran - before.ran).toBe(1);
      stopQpdfRunner();
      process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
    }, 30_000);

    it('declines a job whose arguments hold a NUL or pass the limits, and the usual way answers', async () => {
      process.env[QPDF_RUNNER_PATH_ENV] = runnerBinary;
      stopQpdfRunner();
      expect(await startQpdfRunner()).toBe(true);
      const before = qpdfRunnerState();
      const withNul = await run(['--version', 'a\0b']).catch((e: unknown) => e);
      expect(withNul).toBeInstanceOf(Error); // the usual way's own error: spawn refuses a NUL, and the runner never saw it
      const tooMany = await run(['--version', ...Array.from({ length: 5000 }, () => '--')]).catch((e: unknown) => e);
      expect(tooMany).toBeInstanceOf(Error);
      expect({ ran: qpdfRunnerState().ran - before.ran, fallbacks: qpdfRunnerState().fallbacks - before.fallbacks }).toEqual({ ran: 0, fallbacks: 2 });
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

    /** The kinds of the RESULT frames in the bytes the runner wrote. */
    const resultKinds = (output: Buffer): number[] => {
      const kinds: number[] = [];
      for (let at = 0; at < output.length; ) {
        const length = output.readUInt32BE(at);
        if (output.readUInt8(at + 4) === 11) kinds.push(output.readUInt32BE(at + 9));
        at += 4 + length;
      }
      return kinds;
    };
    const malformed = (id: number): Buffer => rawRun(id, { cwd: 'relative' });

    it('ends with status 2 for a length too short to hold a type and an id, the one case that leaves nothing to resynchronise on', async () => {
      for (const bytes of [header(4, 1, 1), header(0, 1, 1)]) {
        const ended = await feed(bytes);
        expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 2, signal: null });
      }
    });

    it('refuses a frame of a type it does not know, and a frame past its limit, and goes on with the frames after them', async () => {
      const padding = (bytes: number): Buffer => Buffer.alloc(bytes);
      const unknown = Buffer.concat([header(5, 99, 7)]);
      const unknownWithBody = Buffer.concat([header(5 + 100, 98, 8), padding(100)]);
      // A frame 5 MiB long, past the 4 MiB the runner reads, is skipped as it arrives and answered; the frame after it is served.
      const oversized = Buffer.concat([header(5 * 1024 * 1024, 1, 9), padding(5 * 1024 * 1024 - 5)]);
      const ended = await feed(Buffer.concat([unknown, unknownWithBody, oversized, malformed(10)]));
      expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 0, signal: null });
      expect(resultKinds(ended.output)).toEqual([5, 5, 5, 5]);
    });

    it('refuses a length past the limit that is cut short by the end of the input, and ends quietly', async () => {
      const ended = await feed(header(MAX_FRAME_PLUS_ONE, 1, 1));
      expect({ status: ended.status, signal: ended.signal, kinds: resultKinds(ended.output) }).toEqual({ status: 0, signal: null, kinds: [5] });
    });

    it('refuses a standard input past its limit even when no bytes of it follow', async () => {
      const frame = Buffer.concat(encodeRun(4, { ...REQUEST, argv: ['qpdf', 'echo-stdin'] }));
      // The last four bytes of a request with no standard input are the length of the standard input.
      const claimed = Buffer.from(frame);
      claimed.writeUInt32BE(1 << 30, claimed.length - 4);
      const justPast = Buffer.from(frame);
      justPast.writeUInt32BE(32 * 1024 + 1, justPast.length - 4);
      const ended = await feed(Buffer.concat([claimed, justPast]));
      expect({ status: ended.status, signal: ended.signal, kinds: resultKinds(ended.output) }).toEqual({ status: 0, signal: null, kinds: [5, 5] });
    });

    it('ends quietly when its input closes in the middle of a frame or before any', async () => {
      for (const bytes of [Buffer.alloc(0), Buffer.from([0, 0]), header(100, 1, 1)]) {
        const ended = await feed(bytes);
        expect({ status: ended.status, signal: ended.signal }).toEqual({ status: 0, signal: null });
      }
    });

    it('answers a request it cannot take with a refusal, and never dies of one', async () => {
      const ended = await feed(Buffer.concat([rawRun(2, { cwd: 'relative' }), rawRun(3, { argv: [] }), rawRun(4, { stdin: Buffer.alloc(64 * 1024) })]));
      expect({ status: ended.status, signal: ended.signal, kinds: resultKinds(ended.output) }).toEqual({ status: 0, signal: null, kinds: [5, 5, 5] });
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

