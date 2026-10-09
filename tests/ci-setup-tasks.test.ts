import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from './helpers/strict-skip';

/**
 * .github/actions/ci-setup/install-tools.sh runs the independent parts of the tool setup at once. A part that
 * hangs must not hold the runner until the job timeout, and a part that fails must say which one and show its log.
 * The script is sourced into a bash process here so its functions run for real: the limits are exercised with tasks
 * that sleep past them, and the S3 test server task runs against stub `docker` and `curl` binaries that record
 * what they were asked to do.
 */

const ROOT = path.resolve(__dirname, '..');
const ACTION_DIR = path.join(ROOT, '.github', 'actions', 'ci-setup');
const SCRIPT = path.join(ACTION_DIR, 'install-tools.sh');
const IMAGE_PIN = path.join(ACTION_DIR, 's3-test-server-image.txt');

const bash4 = spawnSync('bash', ['-c', '(( BASH_VERSINFO[0] >= 4 ))']).status === 0;
const gnuTimeout = spawnSync('timeout', ['--version'], { encoding: 'utf-8' }).stdout?.includes('GNU coreutils') ?? false;
const sha256sum = spawnSync('sha256sum', ['--version'], { encoding: 'utf-8' }).status === 0;
const canRunSetup = bash4 && gnuTimeout && sha256sum;
const NEEDS = 'bash 4 or newer, GNU timeout and sha256sum';

/** Longest a limit test may take: the sleeping task is cut after 2 s, so anything near its 30 s sleep is a failure. */
const FAST_FAIL_BUDGET_MS = 15_000;
const SLEEP_PAST_LIMIT_SECONDS = 31;
const MAX_TASK_LIMIT_SECONDS = 600;
const EXPECTED_TASKS = ['apt', 'pip', 'verapdf', 'epubcheck', 'raw'];

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-setup-tasks-'));
  temps.push(dir);
  return dir;
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

/** Sources install-tools.sh (which does not run its main flow when sourced) and runs `snippet` after it. */
function runSourced(snippet: string, env: Record<string, string> = {}, extraPath = ''): Outcome {
  const started = Date.now();
  const result = spawnSync('bash', ['-c', `source "$SCRIPT_UNDER_TEST"\n${snippet}`], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...(extraPath ? { PATH: `${extraPath}:${process.env.PATH ?? ''}` } : {}),
      SCRIPT_UNDER_TEST: SCRIPT,
      ACTION_PATH: ACTION_DIR,
      APT_DEBS: '/nonexistent/apt-debs',
      // The messages of bash itself are asserted, so they must not be translated.
      LC_ALL: 'C',
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, elapsedMs: Date.now() - started };
}

describe('the bound on every setup task', () => {
  it.skipIf(skipUnless(NEEDS, canRunSetup))('stops a task that outlives its limit and fails the step naming it, with its log', () => {
    const outcome = runSourced(`
      task_slow() { echo "slow task started"; sleep ${SLEEP_PAST_LIMIT_SECONDS}; echo "never reached"; }
      export -f task_slow
      tasks=(slow)
      task_limit_seconds[slow]=2
      run_tasks
    `);
    expect(outcome.status).toBe(1);
    expect(outcome.elapsedMs).toBeLessThan(FAST_FAIL_BUDGET_MS);
    expect(outcome.stdout).toContain('::error::tool setup failed: slow');
    expect(outcome.stdout).toContain('task slow exceeded its limit of 2s and was stopped');
    expect(outcome.stdout).toContain('slow task started');
    expect(outcome.stdout).not.toContain('never reached');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('stops the processes the task started as well, not only the task shell', () => {
    const pidFile = path.join(scratch(), 'child.pid');
    const outcome = runSourced(`
      task_slow() { sleep ${SLEEP_PAST_LIMIT_SECONDS} & echo $! > "$PID_FILE"; wait; }
      export -f task_slow
      tasks=(slow)
      task_limit_seconds[slow]=2
      run_tasks > /dev/null
      if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then echo CHILD_SURVIVED; fi
    `, { PID_FILE: pidFile });
    expect(outcome.stdout).not.toContain('CHILD_SURVIVED');
    expect(existsSync(pidFile)).toBe(true);
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('lets the other tasks finish and shows their logs when one task fails', () => {
    const outcome = runSourced(`
      task_good() { echo "good output"; }
      task_bad() { echo "bad output" >&2; return 3; }
      export -f task_good task_bad
      tasks=(good bad)
      task_limit_seconds[good]=20
      task_limit_seconds[bad]=20
      run_tasks
    `);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain('::group::good (ok)');
    expect(outcome.stdout).toContain('good output');
    expect(outcome.stdout).toContain('::error::tool setup failed: bad');
    expect(outcome.stdout).toContain('task bad failed with status 3');
    expect(outcome.stdout).toContain('bad output');
    expect(outcome.stdout).not.toContain('::group::bad');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('passes when every task succeeds and reports how long each took', () => {
    const outcome = runSourced(`
      task_good() { echo "good output"; }
      export -f task_good
      tasks=(good)
      task_limit_seconds[good]=20
      run_tasks
    `);
    expect(outcome.status).toBe(0);
    expect(outcome.stdout).toMatch(/task good finished with status 0 after \d+s/);
    expect(outcome.stdout).not.toContain('::error::');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('runs a task with unset variables as an error, as the whole script does', () => {
    const outcome = runSourced(`
      task_unbound() { echo "value: $NO_SUCH_VARIABLE_FOR_THE_TEST"; }
      export -f task_unbound
      tasks=(unbound)
      task_limit_seconds[unbound]=20
      run_tasks
    `);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain('NO_SUCH_VARIABLE_FOR_THE_TEST: unbound variable');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('refuses a task that has no time limit', () => {
    const outcome = runSourced(`
      task_free() { echo "unbounded"; }
      export -f task_free
      tasks=(free)
      run_tasks
    `);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout).toContain('no time limit for task free');
    expect(outcome.stdout).not.toContain('unbounded');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('prints the logs and stops everything when the job is cancelled', () => {
    const dir = scratch();
    const wrapper = path.join(dir, 'cancelled.sh');
    writeFileSync(
      wrapper,
      `source "$SCRIPT_UNDER_TEST"
task_slow() { echo "slow task started"; sleep ${SLEEP_PAST_LIMIT_SECONDS}; }
export -f task_slow
tasks=(slow)
task_limit_seconds[slow]=120
run_tasks
`
    );
    const started = Date.now();
    const result = spawnSync('bash', ['-c', `bash "${wrapper}" & pid=$!; sleep 2; kill -TERM $pid; wait $pid; echo "exit=$?"`], {
      encoding: 'utf-8',
      env: { ...process.env, SCRIPT_UNDER_TEST: SCRIPT, ACTION_PATH: ACTION_DIR, APT_DEBS: '/nonexistent/apt-debs' },
    });
    expect(Date.now() - started).toBeLessThan(FAST_FAIL_BUDGET_MS);
    expect(result.stdout).toContain('::error::tool setup interrupted');
    expect(result.stdout).toContain('slow task started');
    expect(result.stdout).toContain('exit=143');
  });
});

describe('the task list and its limits', () => {
  it.skipIf(skipUnless(NEEDS, canRunSetup))('leaves the S3 test server out unless the job asked for it', () => {
    const without = runSourced('configure; select_tasks; echo "${tasks[*]}"', { S3_TEST_SERVER: 'false' });
    expect(without.status, without.stderr).toBe(0);
    expect(without.stdout.trim()).toBe(EXPECTED_TASKS.join(' '));
    const withServer = runSourced('configure; select_tasks; echo "${tasks[*]}"', {
      S3_TEST_SERVER: 'true',
      STORAGE_TEST_S3_ENDPOINT: 'http://127.0.0.1:9000',
      STORAGE_TEST_S3_ACCESS_KEY_ID: 'id',
      STORAGE_TEST_S3_SECRET_ACCESS_KEY: 'secret',
      STORAGE_TEST_S3_BUCKET: 'bucket',
      S3_IMAGE_CACHE_DIR: '/nonexistent/image-cache',
    });
    expect(withServer.status, withServer.stderr).toBe(0);
    expect(withServer.stdout.trim()).toBe([...EXPECTED_TASKS, 's3'].join(' '));
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('refuses an S3 switch that is neither true nor false, before any task starts', () => {
    for (const value of ['', 'yes', 'TRUE', '1']) {
      const outcome = runSourced('configure', { S3_TEST_SERVER: value });
      expect(outcome.status, value).not.toBe(0);
      expect(outcome.stderr, value).toContain('S3_TEST_SERVER must be true or false');
    }
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('requires the server settings of the job when the S3 test server is on', () => {
    const all = {
      S3_TEST_SERVER: 'true',
      STORAGE_TEST_S3_ENDPOINT: 'http://127.0.0.1:9000',
      STORAGE_TEST_S3_ACCESS_KEY_ID: 'id',
      STORAGE_TEST_S3_SECRET_ACCESS_KEY: 'secret',
      STORAGE_TEST_S3_BUCKET: 'bucket',
      S3_IMAGE_CACHE_DIR: '/nonexistent/image-cache',
    };
    for (const missing of ['STORAGE_TEST_S3_ENDPOINT', 'STORAGE_TEST_S3_ACCESS_KEY_ID', 'STORAGE_TEST_S3_SECRET_ACCESS_KEY', 'STORAGE_TEST_S3_BUCKET', 'S3_IMAGE_CACHE_DIR']) {
      const env: Record<string, string> = { ...all };
      delete env[missing];
      const outcome = runSourced(`unset ${missing}; configure`, env);
      expect(outcome.status, missing).not.toBe(0);
      expect(outcome.stderr, missing).toContain(missing);
    }
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('gives every task a limit that is positive and below ten minutes', () => {
    const outcome = runSourced(`for task in ${[...EXPECTED_TASKS, 's3'].join(' ')}; do echo "$task=\${task_limit_seconds[$task]:-missing}"; done`);
    expect(outcome.status, outcome.stderr).toBe(0);
    const limits = Object.fromEntries(outcome.stdout.trim().split('\n').map((line) => line.split('=')));
    expect(Object.keys(limits).sort()).toEqual([...EXPECTED_TASKS, 's3'].sort());
    for (const [task, value] of Object.entries(limits)) {
      const seconds = Number(value);
      expect(Number.isInteger(seconds), `${task}: ${value}`).toBe(true);
      expect(seconds, task).toBeGreaterThan(0);
      expect(seconds, task).toBeLessThanOrEqual(MAX_TASK_LIMIT_SECONDS);
    }
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('keeps the worst case of the S3 task inside its own limit', () => {
    const outcome = runSourced(
      'for name in S3_PULL_ATTEMPTS S3_PULL_TIMEOUT_SECONDS S3_PULL_BACKOFF_SECONDS S3_RUN_TIMEOUT_SECONDS S3_HEALTH_ATTEMPTS S3_HEALTH_INTERVAL_SECONDS S3_HEALTH_CURL_TIMEOUT_SECONDS S3_SIGV4_CURL_TIMEOUT_SECONDS; do echo "$name=${!name}"; done; echo "limit=${task_limit_seconds[s3]}"'
    );
    expect(outcome.status, outcome.stderr).toBe(0);
    const value = Object.fromEntries(outcome.stdout.trim().split('\n').map((line) => line.split('=')).map(([key, raw]) => [key, Number(raw)]));
    const backoff = value.S3_PULL_BACKOFF_SECONDS * ((value.S3_PULL_ATTEMPTS * (value.S3_PULL_ATTEMPTS - 1)) / 2);
    const worstPull = value.S3_PULL_ATTEMPTS * value.S3_PULL_TIMEOUT_SECONDS + backoff;
    const worstHealth = value.S3_HEALTH_ATTEMPTS * (value.S3_HEALTH_CURL_TIMEOUT_SECONDS + value.S3_HEALTH_INTERVAL_SECONDS);
    const worstSignature = 2 * value.S3_SIGV4_CURL_TIMEOUT_SECONDS;
    expect(worstPull + value.S3_RUN_TIMEOUT_SECONDS + worstHealth + worstSignature).toBeLessThanOrEqual(value.limit);
  });

  it('keeps the work of every task behind the same bounded runner', () => {
    const script = readFileSync(SCRIPT, 'utf-8');
    expect(script).toMatch(/timeout --kill-after="\$\{KILL_GRACE_SECONDS\}s" "\$\{task_limit_seconds\[\$task\]\}s" bash -uo pipefail -c "task_\$task"/);
    expect(script).toContain('"$task_logs/$task.log"');
    expect(script).toContain('::error::tool setup failed:');
    expect(script).toContain('trap on_interrupt INT TERM');
    // The loops are counted, never open ended.
    expect(script).not.toMatch(/\bwhile\b|\buntil\b/);
  });
});

describe('the S3 test server task', () => {
  const STUB_DOCKER = `#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$1" in
  pull) if [ -n "\${STUB_PULL_FAILS:-}" ]; then echo "toomanyrequests" >&2; exit 1; fi; exit 0 ;;
  load) if [ -n "\${STUB_LOAD_FAILS:-}" ]; then echo "load failed" >&2; exit 1; fi; exit 0 ;;
  save) shift; while [ $# -gt 0 ]; do if [ "$1" = -o ]; then printf 'image-bytes' > "$2"; fi; shift; done; exit 0 ;;
  image) exit 0 ;;
  tag) exit 0 ;;
  run) echo container-id; exit 0 ;;
  logs) echo "stub server log"; exit 0 ;;
esac
exit 0
`;
  const STUB_CURL = `#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
case "$*" in
  *minio/health/live*) if [ -n "\${STUB_HEALTH_FAILS:-}" ]; then exit 22; fi; exit 0 ;;
  *wrong-*) printf 403; exit 0 ;;
  *) printf 200; exit 0 ;;
esac
`;
  const STUB_SLEEP = `#!/bin/sh
echo "sleep $*" >> "$STUB_LOG"
exit 0
`;

  function stubBin(): { bin: string; log: string; cache: string } {
    const dir = scratch();
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    for (const [name, body] of [['docker', STUB_DOCKER], ['curl', STUB_CURL], ['sleep', STUB_SLEEP]] as const) {
      writeFileSync(path.join(bin, name), body);
      chmodSync(path.join(bin, name), 0o755);
    }
    return { bin, log: path.join(dir, 'calls.log'), cache: path.join(dir, 'image-cache') };
  }

  function runTask(stub: ReturnType<typeof stubBin>, extra: Record<string, string> = {}): Outcome & { calls: string[] } {
    writeFileSync(stub.log, '');
    const outcome = runSourced(
      'configure; task_s3',
      {
        S3_TEST_SERVER: 'true',
        STORAGE_TEST_S3_ENDPOINT: 'http://127.0.0.1:9000',
        STORAGE_TEST_S3_ACCESS_KEY_ID: 'test-id',
        STORAGE_TEST_S3_SECRET_ACCESS_KEY: 'test-secret',
        STORAGE_TEST_S3_BUCKET: 'test-bucket',
        S3_IMAGE_CACHE_DIR: stub.cache,
        STUB_LOG: stub.log,
        ...extra,
      },
      stub.bin
    );
    return { ...outcome, calls: readFileSync(stub.log, 'utf-8').split('\n').filter(Boolean) };
  }

  const pin = readFileSync(IMAGE_PIN, 'utf-8').trim();

  it.skipIf(skipUnless(NEEDS, canRunSetup))('pulls the pinned image once, stores it for the next job and starts the server on the local tag', () => {
    const stub = stubBin();
    const outcome = runTask(stub);
    expect(outcome.status, outcome.stderr + outcome.stdout).toBe(0);
    const pulls = outcome.calls.filter((call) => call.startsWith('docker pull'));
    expect(pulls).toEqual([`docker pull ${pin}`]);
    expect(outcome.calls.some((call) => call.startsWith('docker tag ') && call.includes(pin))).toBe(true);
    expect(outcome.calls.some((call) => call.startsWith('docker save '))).toBe(true);
    expect(readFileSync(path.join(stub.cache, 'image.tar'), 'utf-8')).toBe('image-bytes');
    const checksum = readFileSync(path.join(stub.cache, 'image.tar.sha256'), 'utf-8');
    expect(checksum).toMatch(/^[0-9a-f]{64} {2}image\.tar\n$/);
    const run = outcome.calls.find((call) => call.startsWith('docker run '));
    expect(run).toContain('--name s3-test-server');
    expect(run).not.toContain(pin);
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('loads the stored image on a cache hit and never contacts the registry', () => {
    const stub = stubBin();
    expect(runTask(stub).status).toBe(0);
    const second = runTask(stub);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.calls.filter((call) => call.startsWith('docker load'))).toHaveLength(1);
    expect(second.calls.filter((call) => call.startsWith('docker pull'))).toEqual([]);
    expect(second.calls.find((call) => call.startsWith('docker run '))).toBeDefined();
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('ignores a cached tarball whose checksum no longer matches and pulls again', () => {
    const stub = stubBin();
    expect(runTask(stub).status).toBe(0);
    writeFileSync(path.join(stub.cache, 'image.tar'), 'truncated');
    const second = runTask(stub);
    expect(second.status, second.stderr + second.stdout).toBe(0);
    expect(second.stdout).toContain('cached image is unusable');
    expect(readFileSync(path.join(stub.cache, 'image.tar'), 'utf-8')).toBe('image-bytes');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('retries a failed pull a bounded number of times, then fails with the pull error', () => {
    const stub = stubBin();
    const outcome = runTask(stub, { STUB_PULL_FAILS: '1' });
    expect(outcome.status).toBe(1);
    expect(outcome.calls.filter((call) => call.startsWith('docker pull'))).toHaveLength(3);
    expect(outcome.stderr + outcome.stdout).toContain('could not pull');
    expect(outcome.stderr + outcome.stdout).toContain('toomanyrequests');
    expect(outcome.calls.some((call) => call.startsWith('docker run '))).toBe(false);
    expect(existsSync(path.join(stub.cache, 'image.tar'))).toBe(false);
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('gives up waiting for the server after a fixed number of probes and shows the server log', () => {
    const stub = stubBin();
    const outcome = runTask(stub, { STUB_HEALTH_FAILS: '1' });
    expect(outcome.status).toBe(1);
    expect(outcome.calls.filter((call) => call.includes('minio/health/live'))).toHaveLength(20);
    expect(outcome.stderr + outcome.stdout).toContain('S3 test server did not become live after 20 attempts');
    expect(outcome.stderr + outcome.stdout).toContain('stub server log');
  });

  it.skipIf(skipUnless(NEEDS, canRunSetup))('proves the server refuses a wrong secret and creates the bucket with the right one', () => {
    const stub = stubBin();
    const outcome = runTask(stub);
    expect(outcome.status).toBe(0);
    const signed = outcome.calls.filter((call) => call.includes('--aws-sigv4'));
    expect(signed).toHaveLength(2);
    expect(signed[0]).toContain('test-id:wrong-test-secret');
    expect(signed[0]).toContain('/signature-check');
    expect(signed[1]).toContain('test-id:test-secret');
    expect(signed[1]).toContain('/test-bucket');
  });
});
