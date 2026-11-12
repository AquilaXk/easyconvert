import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildUnshareIsolationArgs, getUnshareCapability, resolveSandboxedCommand } from '../src/lib/security/process-sandbox';
import { skipUnless } from './helpers/strict-skip';

/**
 * The one program that must keep the network of the worker (the browser of a website capture reaches the gate on the loopback
 * interface) still starts in the namespaces and under the confinement of every other run, with the network namespace left out.
 */

const PROBED = { available: true, path: '/usr/bin/unshare', args: ['-r', '-n'] };
const ON_LINUX = process.platform === 'linux';
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the namespaces of a run that keeps the network', () => {
  it('leaves out the network namespace and nothing else the host gave', () => {
    expect(buildUnshareIsolationArgs(PROBED, { keepNetwork: true })).toEqual(['-r']);
    expect(buildUnshareIsolationArgs(PROBED, { keepNetwork: true, pidNamespace: true })).toEqual(['-r', '-p', '--fork']);
  });

  it('takes the network namespace in every other run', () => {
    expect(buildUnshareIsolationArgs(PROBED, {})).toEqual(['-r', '-n']);
    expect(buildUnshareIsolationArgs(PROBED, { keepNetwork: false })).toEqual(['-r', '-n']);
  });
});

describe.skipIf(skipUnless('unprivileged namespaces (unshare -r -n)', ON_LINUX && getUnshareCapability().available))('the command of a run that keeps the network', () => {
  it('is wrapped in the user namespace without a network namespace, and a run that does not ask for it is not wrapped', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-keep-network-'));
    made.push(workDir);
    const kept = resolveSandboxedCommand('/bin/true', [], { networkIsolated: false, sandboxOptions: { keepNetwork: true }, workDir });
    expect(kept.wrapped).toBe(true);
    expect(kept.args).toContain('-r');
    expect(kept.args).not.toContain('-n');
    const plain = resolveSandboxedCommand('/bin/true', [], { networkIsolated: false, workDir });
    expect(plain).toMatchObject({ binary: '/bin/true', wrapped: false });
  });
});
