import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A host that cannot give a PID namespace runs programs without one. That is said once, and a probe that failed on a cold start or under
 * load does not keep the PID namespace off for the life of the process: the host is tried again after PID_INIT_REPROBE_MS. The programs
 * the probe starts are stand-ins that fail or succeed as the test says; what is read is the capability the sandbox then reports.
 */

const probe = vi.hoisted(() => ({ pidInitWorks: false, calls: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, args: string[]) => {
    probe.calls.push([file, ...args]);
    if (args.includes('--') && args.some((arg) => arg.endsWith('/pid-init-stand-in')) && !probe.pidInitWorks) throw new Error('unshare: unshare failed: Operation not permitted');
    return Buffer.alloc(0);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import { getUnshareCapability, PID_INIT_REPROBE_MS, resetUnshareCapabilityCache } from '../src/lib/security/process-sandbox';

const PID_INIT = '/opt/test/pid-init-stand-in';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === '/usr/bin/unshare' || candidate === PID_INIT);
  vi.stubEnv('PID_INIT_PATH', PID_INIT);
  vi.stubEnv('SANDBOX_PID_NAMESPACE', 'true');
  vi.useFakeTimers({ toFake: ['Date'] });
  probe.pidInitWorks = false;
  probe.calls = [];
  resetUnshareCapabilityCache();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetUnshareCapabilityCache();
});

describe('the PID namespace probe', () => {
  it('says once that runs go without a PID namespace, and does not probe again before the backoff has passed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getUnshareCapability()).toMatchObject({ available: true, pidInitPath: '' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('without a PID namespace');
    const probes = probe.calls.length;
    vi.setSystemTime(Date.now() + PID_INIT_REPROBE_MS - 1);
    expect(getUnshareCapability().pidInitPath).toBe('');
    expect(probe.calls.length).toBe(probes);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('tries the host again after the backoff, and uses pid-init from then on when the probe passes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getUnshareCapability().pidInitPath).toBe('');
    probe.pidInitWorks = true;
    vi.setSystemTime(Date.now() + PID_INIT_REPROBE_MS);
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    const probes = probe.calls.length;
    vi.setSystemTime(Date.now() + 10 * PID_INIT_REPROBE_MS);
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    expect(probe.calls.length).toBe(probes);
  });

  it('keeps saying nothing more while it stays degraded', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getUnshareCapability();
    vi.setSystemTime(Date.now() + PID_INIT_REPROBE_MS);
    getUnshareCapability();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('names a missing pid-init in the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('PID_INIT_PATH', '/opt/test/not-there');
    expect(getUnshareCapability().pidInitPath).toBe('');
    expect(warn.mock.calls[0][0]).toContain('no pid-init program was found');
  });
});
