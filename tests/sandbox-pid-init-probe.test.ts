import fs from 'node:fs';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A host that cannot give a PID namespace runs programs without one. That is said once, and a probe that failed on a cold start or under
 * load does not keep the PID namespace off for the life of the process: the host is tried again after PID_INIT_REPROBE_MS. The programs
 * the probe starts are stand-ins that fail or succeed as the test says; what is read is the capability the sandbox then reports.
 */

const probe = vi.hoisted(() => ({ pidInitWorks: false, procHideWorks: true, confineWorks: true, foldWorks: false, userNamespaceWorks: true, calls: [] as string[][] }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFileSync = ((file: string, args: string[]) => {
    probe.calls.push([file, ...args]);
    if (args.includes('--') && args.includes('-r') && !probe.userNamespaceWorks) throw new Error('unshare: unshare failed: Operation not permitted');
    if (args.includes('--') && args.some((arg) => arg.endsWith('/pid-init-stand-in')) && !probe.pidInitWorks) throw new Error('unshare: unshare failed: Operation not permitted');
    // A pid-init that predates --userns-net prints its usage and exits 2.
    if (args.includes('--userns-net') && !probe.foldWorks) throw new Error('Command failed: exit status 2');
    if (args.includes('--check') && args.includes('--confine') && !probe.confineWorks) throw new Error('Command failed: exit status 3');
    if (args.includes('--check') && !args.includes('--confine') && !probe.procHideWorks) throw new Error('Command failed: exit status 3');
    return Buffer.alloc(0);
  }) as typeof actual.execFileSync;
  return { ...actual, default: { ...actual, execFileSync }, execFileSync };
});

import { SandboxUnavailableError } from '../src/lib/types';
import { buildPidInitRlimitArgs, buildPrlimitArgs, fileConfinementDisabled, getPrlimitCapability, getUnshareCapability, PID_INIT_REPROBE_MS, PID_INIT_STRICT_REPROBE_MS, resetPrlimitCapabilityCache, resetUnshareCapabilityCache, resolveSandboxedCommand, strictSandboxEnabled, withoutProcHideNotice } from '../src/lib/security/process-sandbox';

const PID_INIT = '/opt/test/pid-init-stand-in';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === '/usr/bin/unshare' || candidate === '/usr/bin/prlimit' || candidate === PID_INIT);
  vi.stubEnv('PID_INIT_PATH', PID_INIT);
  vi.stubEnv('SANDBOX_PID_NAMESPACE', undefined);
  vi.stubEnv('SANDBOX_HIDE_PROC', undefined);
  vi.stubEnv('SANDBOX_CONFINE_FILES', undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  probe.pidInitWorks = false;
  probe.procHideWorks = true;
  probe.confineWorks = true;
  probe.foldWorks = false;
  probe.userNamespaceWorks = true;
  probe.calls = [];
  resetUnshareCapabilityCache();
  resetPrlimitCapabilityCache();
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

  it('is on unless SANDBOX_PID_NAMESPACE is false, and then neither probes nor says anything', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    resetUnshareCapabilityCache();
    probe.calls = [];
    vi.stubEnv('SANDBOX_PID_NAMESPACE', 'false');
    expect(getUnshareCapability()).toMatchObject({ available: true, pidInitPath: '' });
    expect(probe.calls.filter((call) => call.some((arg) => arg.endsWith('/pid-init-stand-in')))).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    resetUnshareCapabilityCache();
    vi.stubEnv('SANDBOX_PID_NAMESPACE', ' FALSE ');
    expect(getUnshareCapability().pidInitPath).toBe('');
  });
  it('asks pid-init whether it can hide the /proc entries of the other runs, and says nothing when it can', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    expect(probe.calls.filter((call) => call.includes('--check') && !call.includes('--confine'))).toHaveLength(1);
    expect(probe.calls.filter((call) => call.includes('--check') && call.includes('--confine'))).toHaveLength(1);
    expect(getUnshareCapability().confinesFiles).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('says once that the /proc entries of the other runs can be read when pid-init cannot make the ruleset, and keeps the PID namespace', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    probe.procHideWorks = false;
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('command line and the status of the other runs');
    expect(warn.mock.calls[0][0]).toContain('Landlock');
    vi.setSystemTime(Date.now() + 10 * PID_INIT_REPROBE_MS);
    getUnshareCapability();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('asks pid-init whether it can confine files, says once that the files of the other runs can be read when it cannot, and reads SANDBOX_CONFINE_FILES when a run starts, not when the host is probed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    probe.confineWorks = false;
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, confinesFiles: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('files of the other runs');
    // A host that can confine nothing is asked again after the backoff, and is confined once it can.
    probe.confineWorks = true;
    vi.setSystemTime(Date.now() + PID_INIT_REPROBE_MS);
    expect(getUnshareCapability().confinesFiles).toBe(true);
    for (const value of ['false', ' FALSE ']) {
      resetUnshareCapabilityCache();
      probe.calls = [];
      vi.stubEnv('SANDBOX_CONFINE_FILES', value);
      expect(fileConfinementDisabled()).toBe(true);
      expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, confinesFiles: true });
      const command = resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, workDir: '/jobs/one' });
      expect(command.args).not.toContain('--confine');
    }
  });

  it('asks a host that failed the probe again after a few seconds under STRICT_SANDBOX, where every run is refused until it passes, and after a minute otherwise', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('STRICT_SANDBOX', 'true');
    expect(getUnshareCapability().pidInitPath).toBe('');
    probe.pidInitWorks = true;
    vi.setSystemTime(Date.now() + PID_INIT_STRICT_REPROBE_MS - 1);
    expect(getUnshareCapability().pidInitPath).toBe('');
    vi.setSystemTime(Date.now() + 1);
    expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
    expect(PID_INIT_STRICT_REPROBE_MS).toBeLessThan(PID_INIT_REPROBE_MS);
  });

  it('passes --confine with the directories of the run to pid-init, --require under STRICT_SANDBOX, and the program itself to read', () => {
    probe.pidInitWorks = true;
    const wrapperOf = (options: Parameters<typeof resolveSandboxedCommand>[2]) => {
      const command = resolveSandboxedCommand('/opt/tool/bin/tool', ['a'], options);
      return command.args.slice(command.args.indexOf(PID_INIT), command.args.lastIndexOf('/opt/tool/bin/tool'));
    };
    expect(wrapperOf({ networkIsolated: true, workDir: '/jobs/one', writeDirs: ['/jobs/profile'], readDirs: ['/models/m.onnx'] })).toEqual([
      PID_INIT, '--confine', '--write', '/jobs/one', '--write', '/jobs/profile', '--read', '/models/m.onnx', '--read', '/opt/tool/bin/tool', '--',
    ]);
    expect(wrapperOf({ networkIsolated: true, workDir: null })).toEqual([PID_INIT, '--confine', '--read', '/opt/tool/bin/tool', '--']);
    expect(wrapperOf({ networkIsolated: true, workDir: '/jobs/one', strictIsolation: true })).toContain('--require');
    // A run that names no directory is not confined (the access every run had), and under STRICT_SANDBOX it is refused.
    expect(wrapperOf({ networkIsolated: true })).toEqual([PID_INIT, '--']);
    expect(() => wrapperOf({ networkIsolated: true, strictIsolation: true })).toThrow(/does not name the directory of its job/);
    probe.confineWorks = false;
    resetUnshareCapabilityCache();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(wrapperOf({ networkIsolated: true, workDir: '/jobs/one' })).toEqual([PID_INIT, '--']);
    expect(() => wrapperOf({ networkIsolated: true, workDir: '/jobs/one', strictIsolation: true })).toThrow(/cannot confine the files/);
  });

  it('refuses a program under STRICT_SANDBOX when the host has no pid-init, whatever the switch for the files says', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const start = () => resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, workDir: '/jobs/one', strictIsolation: true });
    // No pid-init program, the PID namespace turned off, and the confinement turned off on top: the program is never started in none of them.
    vi.stubEnv('PID_INIT_PATH', '');
    vi.stubEnv('SANDBOX_CONFINE_FILES', 'false');
    resetUnshareCapabilityCache();
    expect(start).toThrow(/no pid-init/);
    vi.stubEnv('PID_INIT_PATH', PID_INIT);
    vi.stubEnv('SANDBOX_PID_NAMESPACE', 'false');
    resetUnshareCapabilityCache();
    expect(start).toThrow(/no pid-init/);
    expect(() => resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, workDir: '/jobs/one', strictIsolation: false })).not.toThrow();
  });

  it('reads STRICT_SANDBOX as the start-up check does, so " True " refuses a run without a job directory', () => {
    probe.pidInitWorks = true;
    for (const value of [' True ', 'TRUE']) {
      vi.stubEnv('STRICT_SANDBOX', value);
      expect(strictSandboxEnabled()).toBe(true);
      expect(() => resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true })).toThrow(SandboxUnavailableError);
    }
    vi.stubEnv('STRICT_SANDBOX', 'yes');
    expect(strictSandboxEnabled()).toBe(false);
  });

  it('refuses a directory it cannot confine to with the typed 503 error, not a plain one', () => {
    probe.pidInitWorks = true;
    for (const workDir of ['relative/dir', '/', os.tmpdir()]) {
      expect(() => resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, workDir })).toThrow(SandboxUnavailableError);
    }
  });

  it('starts a program that opts out of the PID namespace through pid-init, which hides /proc and becomes the program in place', () => {
    probe.pidInitWorks = true;
    const own = resolveSandboxedCommand('/usr/bin/tool', ['a'], { networkIsolated: true });
    expect(own).toMatchObject({ levelsAboveProgram: 2 });
    expect(own.args.slice(own.args.indexOf('--'), own.args.indexOf('--') + 3)).toEqual(['--', PID_INIT, '--']);
    const optedOut = resolveSandboxedCommand('/usr/bin/tool', ['a'], { networkIsolated: true, sandboxOptions: { pidNamespace: false } });
    expect(optedOut).toMatchObject({ levelsAboveProgram: 0 });
    expect(optedOut.args.slice(optedOut.args.indexOf('--'), optedOut.args.indexOf('--') + 4)).toEqual(['--', PID_INIT, '--no-pid-namespace', '--']);
    expect(optedOut.args.slice(-2)).toEqual(['/usr/bin/tool', 'a']);
  });
  it('is on unless SANDBOX_HIDE_PROC is false (any case, trimmed): then it keeps the PID namespace, passes --keep-proc and does not ask pid-init about the ruleset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    probe.procHideWorks = false;
    for (const value of ['false', ' FALSE ']) {
      resetUnshareCapabilityCache();
      probe.calls = [];
      vi.stubEnv('SANDBOX_HIDE_PROC', value);
      expect(getUnshareCapability().pidInitPath).toBe(PID_INIT);
      expect(probe.calls.filter((call) => call.includes('--check') && !call.includes('--confine'))).toEqual([]);
      for (const sandboxOptions of [undefined, { pidNamespace: false }]) {
        const command = resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, sandboxOptions });
        const wrapper = command.args.slice(command.args.indexOf('--') + 1, command.args.indexOf('/usr/bin/tool'));
        expect(wrapper).toContain('--keep-proc');
        expect(wrapper).toContain(PID_INIT);
      }
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets a single call keep the /proc entries readable with hideProc: false, and no other call', () => {
    probe.pidInitWorks = true;
    const wrapperOf = (sandboxOptions?: { pidNamespace?: boolean; hideProc?: boolean }): string[] => {
      const command = resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: true, sandboxOptions });
      return command.args.slice(command.args.indexOf('--') + 1, command.args.indexOf('/usr/bin/tool'));
    };
    expect(wrapperOf({ hideProc: false })).toEqual([PID_INIT, '--keep-proc', '--']);
    expect(wrapperOf({ pidNamespace: false, hideProc: false })).toEqual([PID_INIT, '--no-pid-namespace', '--keep-proc', '--']);
    expect(wrapperOf()).toEqual([PID_INIT, '--']);
  });

  it('takes the notice of a run that could not be hidden off the start of its standard error, and says so once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const notice = 'pid-init: /proc not hidden: a rule could not be added\n';
    expect(withoutProcHideNotice(Buffer.from(`${notice}the program said this\n`)).toString()).toBe('the program said this\n');
    expect(withoutProcHideNotice(Buffer.from(notice)).toString()).toBe('');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('a rule could not be added');
    const untouched = Buffer.from(`the program said this first\n${notice}`);
    expect(withoutProcHideNotice(untouched)).toBe(untouched);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * pid-init takes over `unshare -r -n` and `prlimit` where it can (its own --userns-net and --rlimit), so that a run is one launcher and the tool. A host whose
 * pid-init predates the options, or that cannot make the namespaces from it, keeps the chain; the probe decides, once, and the rest of this file shows the chain.
 */
describe('the launcher that makes the namespaces and sets the limits itself', () => {
  const RLIMITS = { asBytes: 512 * 1024 * 1024, fsizeBytes: 1_048_576, nproc: 64, cpuSeconds: 30, coreBytes: 0 };
  const FOLDED_OPTIONS = ['--userns-net', '--rlimit', `as=${512 * 1024 * 1024}:${512 * 1024 * 1024}`, '--rlimit', 'fsize=1048576:1048576', '--rlimit', 'nproc=64:64', '--rlimit', 'cpu=30:30', '--rlimit', 'core=0:0'];
  const start = (options: Partial<Parameters<typeof resolveSandboxedCommand>[2] & object> = {}) => resolveSandboxedCommand('/usr/bin/tool', ['a'], { networkIsolated: true, rlimits: RLIMITS, ...options });

  it('asks pid-init directly, once, whether it makes the namespaces and sets a limit on this host', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, pidInitFolds: true });
    expect(probe.calls.filter((call) => call.includes('--userns-net'))).toEqual([[PID_INIT, '--userns-net', '--rlimit', 'core=0:0', '--', '/bin/true']]);
    getUnshareCapability();
    expect(probe.calls.filter((call) => call.includes('--userns-net'))).toHaveLength(1);
  });

  it('starts a run with pid-init in front of the tool, with the namespaces and the limits as its options, and no unshare and no prlimit', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    const command = start();
    expect(command).toMatchObject({ binary: PID_INIT, wrapped: true, levelsAboveProgram: 2 });
    expect(command.args).toEqual([...FOLDED_OPTIONS, '--', '/usr/bin/tool', 'a']);
  });

  it('puts the same limits on the program as prlimit does in the chain', () => {
    probe.pidInitWorks = true;
    const prlimit = buildPrlimitArgs(getPrlimitCapability(), RLIMITS);
    const pidInit = buildPidInitRlimitArgs(RLIMITS);
    expect(prlimit).toEqual([`--as=${512 * 1024 * 1024}`, '--fsize=1048576', '--nproc=64', '--cpu=30', '--core=0']);
    expect(pidInit.filter((_, index) => index % 2 === 1).map((spec) => spec.replace(/:\d+$/, ''))).toEqual(prlimit.map((flag) => flag.slice(2)));
    expect(buildPidInitRlimitArgs({})).toEqual([]);
    expect(buildPidInitRlimitArgs({ asBytes: Number.NaN, nproc: -1, coreBytes: 1.5 })).toEqual([]);
  });

  it('keeps the options of the files, of /proc and of the PID namespace, after its own', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    const wrapperOf = (options: Parameters<typeof resolveSandboxedCommand>[2]) => {
      const command = resolveSandboxedCommand('/opt/tool/bin/tool', ['a'], options);
      return command.args.slice(0, command.args.lastIndexOf('/opt/tool/bin/tool'));
    };
    expect(wrapperOf({ networkIsolated: true, workDir: '/jobs/one', strictIsolation: true, sandboxOptions: { hideProc: false } })).toEqual([
      '--userns-net', '--keep-proc', '--confine', '--require', '--write', '/jobs/one', '--read', '/opt/tool/bin/tool', '--',
    ]);
    const optedOut = resolveSandboxedCommand('/usr/bin/tool', ['a'], { networkIsolated: true, rlimits: { coreBytes: 0 }, sandboxOptions: { pidNamespace: false } });
    expect(optedOut).toMatchObject({ binary: PID_INIT, levelsAboveProgram: 0 });
    expect(optedOut.args).toEqual(['--no-pid-namespace', '--userns-net', '--rlimit', 'core=0:0', '--', '/usr/bin/tool', 'a']);
  });

  it('keeps the chain on a host whose pid-init predates the options, or cannot make the namespaces itself, and says nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    probe.pidInitWorks = true;
    probe.foldWorks = false;
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, pidInitFolds: false });
    const command = start();
    expect(command.binary).toBe('/usr/bin/unshare');
    expect(command.args).toEqual(['-r', '-n', '--', PID_INIT, '--', '/usr/bin/prlimit', ...buildPrlimitArgs(getPrlimitCapability(), RLIMITS), '--', '/usr/bin/tool', 'a']);
    expect(command.args).not.toContain('--userns-net');
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the chain for a run that wants other namespaces than `unshare -r -n` makes, and for the PID namespace of unshare', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    expect(start({ sandboxOptions: { mountNamespace: true } }).binary).toBe('/usr/bin/unshare');
    expect(start({ sandboxOptions: { ipcNamespace: true } }).binary).toBe('/usr/bin/unshare');
    expect(start({ sandboxOptions: { pidNamespace: true } }).binary).toBe('/usr/bin/unshare');
    // The network of the worker is kept: only the user namespace is made, which pid-init does not offer alone.
    expect(resolveSandboxedCommand('/usr/bin/tool', [], { networkIsolated: false, sandboxOptions: { keepNetwork: true } }).binary).toBe('/usr/bin/unshare');
  });

  it('is not asked of a host whose unshare takes -n only (no user namespace), which keeps the chain', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    probe.userNamespaceWorks = false;
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, pidInitFolds: false });
    expect(probe.calls.filter((call) => call.includes('--userns-net'))).toEqual([]);
  });

  it('needs no prlimit on the host for the task limit when pid-init sets it, and still refuses it where nothing can', () => {
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) => candidate === '/usr/bin/unshare' || candidate === PID_INIT);
    expect(() => start()).not.toThrow();
    probe.foldWorks = false;
    resetUnshareCapabilityCache();
    resetPrlimitCapabilityCache();
    expect(() => start()).toThrow(SandboxUnavailableError);
  });

  it('is tried again after the backoff like the rest of the probe, and does not make a run of the chain wait for it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: '', pidInitFolds: false });
    probe.pidInitWorks = true;
    probe.foldWorks = true;
    vi.setSystemTime(Date.now() + PID_INIT_REPROBE_MS);
    expect(getUnshareCapability()).toMatchObject({ pidInitPath: PID_INIT, pidInitFolds: true });
  });
});
