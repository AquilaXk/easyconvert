import { afterEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import net from 'node:net';
import { promisify } from 'node:util';
import { executeSandboxedBinary } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';

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
  }
);
