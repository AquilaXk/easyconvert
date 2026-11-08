import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { promisify } from 'node:util';
import { executeSandboxedBinary, getUnshareCapability, memoryWatchPid } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';

// The PID namespace is off by default (src/lib/security/process-sandbox.ts); these tests are about it, so they turn it on.
process.env.SANDBOX_PID_NAMESPACE = 'true';

/**
 * What the namespace sandbox guarantees a native child, observed from inside the child. The child is this Node binary
 * running a few lines of script, so the observations come from the kernel (a refused connect, the PID the child reads
 * back), never from the module that builds the `unshare` command line. Each claim has a control: the same script run
 * outside the sandbox must see the opposite, or the sandboxed result proves nothing.
 */

const UNSHARE_PROBE_TIMEOUT_MS = 2_000;
const CHILD_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;
const LOOPBACK = '127.0.0.1';
const SANDBOX_INIT_PID = 1;
/** Time the parent's event loop gets to run the accept callback of a connection the kernel already completed. */
const ACCEPT_SETTLE_MS = 100;

/** Whether this host lets an unprivileged process create user, network and PID namespaces (a forked child for the last). */
function canCreateNamespaces(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('unshare', ['-r', '-n', '-p', '--fork', '--', 'true'], { stdio: 'ignore', timeout: UNSHARE_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

const CONNECT_SCRIPT = `
const net = require('node:net');
const socket = net.connect({ host: '${LOOPBACK}', port: Number(process.argv[1]) });
socket.on('connect', () => { console.log('connected'); socket.destroy(); });
socket.on('error', (err) => { console.log('error:' + err.code); });
`;

const PID_SCRIPT = `
const parentPid = Number(process.argv[1]);
let parentVisible = true;
try { process.kill(parentPid, 0); } catch (err) { parentVisible = err.code === 'EPERM'; }
console.log(JSON.stringify({ pid: process.pid, parentVisible }));
`;

const SIBLING_MARKER = 'sandbox-sibling-marker';
const LEFTOVER_MARKER = 'sandbox-leftover-marker';
const SIBLING_LIFETIME_MS = 25_000;
const SIBLING_START_WAIT_MS = 10_000;
const POLL_MS = 50;

/** What a run reports about the host PID of a sibling run: whether kill(pid, 0) finds it, and what a SIGTERM to it did. */
const SIBLING_SCRIPT = `
const target = Number(process.argv[1]);
const result = {};
for (const [name, signal] of [['probe', 0], ['term', 'SIGTERM']]) {
  try { process.kill(target, signal); result[name] = 'delivered'; } catch (err) { result[name] = err.code; }
}
console.log(JSON.stringify(result));
`;

/** Host PIDs of the processes whose command line starts with `program` and holds the marker (by default the node of a sibling run, not the wrappers around it). */
function findMarkedPids(marker = SIBLING_MARKER, program = process.execPath): number[] {
  const found: number[] = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const argv = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf-8').split('\0');
      if (argv[0] === program && argv.includes(marker)) found.push(Number(entry));
    } catch {
      // The process ended while the directory was read.
    }
  }
  return found;
}

async function waitForMarkedPid(): Promise<number> {
  const deadline = Date.now() + SIBLING_START_WAIT_MS;
  while (Date.now() < deadline) {
    const [pid] = findMarkedPids();
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('the sibling run did not start');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Listener {
  port: number;
  accepted: () => number;
  close: () => Promise<void>;
}

/** A TCP listener the parent owns on an ephemeral loopback port, counting the connections it accepts. */
async function listen(): Promise<Listener> {
  let accepted = 0;
  const server = net.createServer((socket) => {
    accepted += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, accepted: () => accepted, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Lets the listener's accept callback run before the count is read. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ACCEPT_SETTLE_MS));
}

const execFileAsync = promisify(execFile);

/** Runs the script in a plain child of this process; asynchronous, so the parent's listener keeps accepting. */
async function runUnsandboxed(script: string, argument: string): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, ['-e', script, argument], { timeout: CHILD_TIMEOUT_MS });
  return stdout.trim();
}

// skip-ok: unprivileged user, network and PID namespaces are a kernel setting; skipUnless fails the run under ORACLE_STRICT_MODE=1.
describe.skipIf(skipUnless('unprivileged user, network and PID namespaces (unshare -r -n -p --fork)', canCreateNamespaces()))(
  'the namespace sandbox as the child sees it',
  () => {
    let listener: Listener | undefined;

    afterEach(async () => {
      await listener?.close();
      listener = undefined;
    });

    it(
      'control: outside the sandbox the child reaches the listener the parent opened',
      async () => {
        listener = await listen();
        expect(await runUnsandboxed(CONNECT_SCRIPT, String(listener.port))).toBe('connected');
        await settle();
        expect(listener.accepted()).toBe(1);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'a sandboxed child cannot connect to a listener the parent opened on loopback',
      async () => {
        listener = await listen();
        const run = await executeSandboxedBinary(process.execPath, ['-e', CONNECT_SCRIPT, String(listener.port)], {
          timeoutMs: CHILD_TIMEOUT_MS,
        });
        expect(run.stdout.toString('utf-8').trim()).toMatch(/^error:(ENETUNREACH|ECONNREFUSED|EHOSTUNREACH)$/);
        await settle();
        expect(listener.accepted()).toBe(0);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'control: outside the sandbox the child has its own host PID and can see the parent',
      async () => {
        const seen = JSON.parse(await runUnsandboxed(PID_SCRIPT, String(process.pid)));
        expect(seen.pid).not.toBe(SANDBOX_INIT_PID);
        expect(seen.parentVisible).toBe(true);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'a child in a private PID namespace is PID 1 and cannot see the parent process',
      async () => {
        const run = await executeSandboxedBinary(process.execPath, ['-e', PID_SCRIPT, String(process.pid)], {
          timeoutMs: CHILD_TIMEOUT_MS,
          sandboxOptions: { pidNamespace: true },
        });
        expect(JSON.parse(run.stdout.toString('utf-8'))).toEqual({ pid: SANDBOX_INIT_PID, parentVisible: false });
      },
      TEST_TIMEOUT_MS
    );
    // skip-ok: pid-init (native/pid-init) is built by the image and the CI setup; skipUnless fails the run under ORACLE_STRICT_MODE=1 without it.
    describe.skipIf(skipUnless('pid-init (the PID namespace of every run)', getUnshareCapability().pidInitPath !== ''))('a sibling run of the same worker', () => {
      let siblingEnd: AbortController | undefined;
      let sibling: Promise<unknown> | undefined;

      afterEach(async () => {
        siblingEnd?.abort();
        await sibling;
        siblingEnd = undefined;
        sibling = undefined;
      });

      async function startSibling(): Promise<number> {
        siblingEnd = new AbortController();
        sibling = executeSandboxedBinary(process.execPath, ['-e', `setTimeout(() => {}, ${SIBLING_LIFETIME_MS})`, SIBLING_MARKER], {
          timeoutMs: SIBLING_LIFETIME_MS + CHILD_TIMEOUT_MS,
          signal: siblingEnd.signal,
        }).catch(() => undefined);
        return waitForMarkedPid();
      }

      it(
        'control: a run that opts out of the PID namespace finds the sibling and can signal it',
        async () => {
          const siblingPid = await startSibling();
          const run = await executeSandboxedBinary(process.execPath, ['-e', SIBLING_SCRIPT, String(siblingPid)], {
            timeoutMs: CHILD_TIMEOUT_MS,
            sandboxOptions: { pidNamespace: false },
          });
          expect(JSON.parse(run.stdout.toString('utf-8'))).toEqual({ probe: 'delivered', term: 'delivered' });
        },
        TEST_TIMEOUT_MS
      );

      it(
        'a sandboxed run cannot find the sibling or signal it, and the sibling keeps running',
        async () => {
          const siblingPid = await startSibling();
          const run = await executeSandboxedBinary(process.execPath, ['-e', SIBLING_SCRIPT, String(siblingPid)], {
            timeoutMs: CHILD_TIMEOUT_MS,
          });
          expect(JSON.parse(run.stdout.toString('utf-8'))).toEqual({ probe: 'ESRCH', term: 'ESRCH' });
          expect(isAlive(siblingPid)).toBe(true);
        },
        TEST_TIMEOUT_MS
      );
      it(
        'reads the memory of the program, not of the processes it was started through',
        async () => {
          const programPid = await startSibling();
          const [wrapper] = findMarkedPids(SIBLING_MARKER, getUnshareCapability().pidInitPath);
          expect(wrapper, 'the pid-init process of the sibling').toBeDefined();
          expect(memoryWatchPid(wrapper, 1)).not.toBe(programPid);
          expect(memoryWatchPid(wrapper, 2)).toBe(programPid);
        },
        TEST_TIMEOUT_MS
      );

      it(
        'ends what a run left running when the run ends',
        async () => {
          const leaver = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${SIBLING_LIFETIME_MS})', '${LEFTOVER_MARKER}'], { stdio: 'ignore', detached: true }).unref();`;
          await executeSandboxedBinary(process.execPath, ['-e', leaver], { timeoutMs: CHILD_TIMEOUT_MS });
          const deadline = Date.now() + SIBLING_START_WAIT_MS;
          while (findMarkedPids(LEFTOVER_MARKER).length > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
          expect(findMarkedPids(LEFTOVER_MARKER)).toEqual([]);
        },
        TEST_TIMEOUT_MS
      );
    });
  }
);
