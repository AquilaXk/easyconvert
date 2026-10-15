import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * docker/seccomp-worker.json is read as the container runtime reads it. The expected values are written out here from
 * the kernel's uapi `sched.h` (clone flag bits) and `errno.h`, never computed by the code that produced the profile.
 */

interface ArgumentRule {
  index: number;
  value: number;
  valueTwo?: number;
  op: string;
}

interface SyscallRule {
  names: string[];
  action: string;
  args?: ArgumentRule[];
  errnoRet?: number;
  includes?: unknown;
  excludes?: unknown;
}

interface SeccompProfile {
  defaultAction: string;
  defaultErrnoRet: number;
  archMap: Array<{ architecture: string; subArchitectures: string[] }>;
  syscalls: SyscallRule[];
}

const PROFILE: SeccompProfile = JSON.parse(readFileSync(path.resolve(__dirname, '..', 'docker', 'seccomp-worker.json'), 'utf-8'));

const CLONE_NEWNS = 0x00020000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
const CLONE_NEWUTS = 0x04000000;
const CLONE_NEWIPC = 0x08000000;
const CLONE_NEWCGROUP = 0x02000000;
const CLONE_NEWTIME = 0x00000080;
/** CLONE_VM | CLONE_FS | CLONE_FILES | CLONE_SIGHAND | CLONE_THREAD | CLONE_SYSVSEM | CLONE_SETTLS | CLONE_PARENT_SETTID | CLONE_CHILD_CLEARTID: what pthread_create passes. */
const THREAD_CLONE_FLAGS = 0x003d0f00;
const ENOSYS = 38;
const EPERM = 1;

const SANDBOX_NAMESPACES = CLONE_NEWUSER | CLONE_NEWNET | CLONE_NEWPID | CLONE_NEWNS;

const UNCONDITIONAL_ALLOW = PROFILE.syscalls[0];
const ALLOWED = new Set(UNCONDITIONAL_ALLOW.names);

/** Whether libseccomp lets a call with these flags through a rule whose only condition is a masked comparison. */
function maskedRuleAdmits(rule: SyscallRule, flags: number): boolean {
  const [condition] = rule.args ?? [];
  expect(condition.op).toBe('SCMP_CMP_MASKED_EQ');
  return ((flags & condition.value) >>> 0) === (condition.valueTwo ?? 0);
}

function rulesFor(name: string): SyscallRule[] {
  return PROFILE.syscalls.slice(1).filter((rule) => rule.names.includes(name));
}

describe('docker/seccomp-worker.json', () => {
  it('denies by default with EPERM and covers both worker architectures', () => {
    expect(PROFILE.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(PROFILE.defaultErrnoRet).toBe(EPERM);
    expect(PROFILE.archMap.map((entry) => entry.architecture)).toEqual(['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64']);
  });

  it('depends on no capability: no rule is gated on one being held', () => {
    for (const rule of PROFILE.syscalls) {
      expect(rule.includes).toBeUndefined();
      expect(rule.excludes).toBeUndefined();
    }
  });

  it('allows the calls a native engine and the Node runtime make', () => {
    for (const name of ['read', 'write', 'openat', 'execve', 'mmap', 'futex', 'epoll_wait', 'socket', 'connect', 'prlimit64', 'prctl', 'seccomp', 'pipe2', 'wait4']) {
      expect(ALLOWED.has(name), name).toBe(true);
    }
  });

  it('keeps every call that needs a capability, or reaches other processes and the kernel, out of the allow list', () => {
    const denied = [
      'mount', 'umount2', 'pivot_root', 'chroot', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'bpf', 'keyctl', 'add_key',
      'request_key', 'perf_event_open', 'kexec_load', 'kexec_file_load', 'init_module', 'finit_module', 'delete_module', 'reboot',
      'swapon', 'swapoff', 'open_by_handle_at', 'name_to_handle_at', 'userfaultfd', 'io_uring_setup', 'settimeofday', 'clock_settime',
      'setdomainname', 'sethostname', 'iopl', 'ioperm', 'syslog', 'quotactl', 'fsopen', 'fsmount', 'move_mount', 'open_tree',
      'clone', 'clone3', 'unshare', 'setns', 'personality',
    ];
    for (const name of denied) {
      expect(ALLOWED.has(name), name).toBe(false);
    }
  });

  it('permits clone only for the user, network, PID and mount namespaces', () => {
    const rules = rulesFor('clone');
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('SCMP_ACT_ALLOW');
    expect(rules[0].args).toEqual([{ index: 0, value: CLONE_NEWUTS | CLONE_NEWIPC | CLONE_NEWCGROUP, valueTwo: 0, op: 'SCMP_CMP_MASKED_EQ' }]);
    expect(maskedRuleAdmits(rules[0], SANDBOX_NAMESPACES | 0x11)).toBe(true);
    expect(maskedRuleAdmits(rules[0], THREAD_CLONE_FLAGS)).toBe(true);
    for (const refused of [CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWCGROUP, SANDBOX_NAMESPACES | CLONE_NEWUTS]) {
      expect(maskedRuleAdmits(rules[0], refused)).toBe(false);
    }
  });

  it('permits unshare for the same namespaces and refuses the time namespace too', () => {
    const rules = rulesFor('unshare');
    expect(rules).toHaveLength(1);
    expect(rules[0].action).toBe('SCMP_ACT_ALLOW');
    expect(maskedRuleAdmits(rules[0], SANDBOX_NAMESPACES)).toBe(true);
    for (const refused of [CLONE_NEWUTS, CLONE_NEWIPC, CLONE_NEWCGROUP, CLONE_NEWTIME]) {
      expect(maskedRuleAdmits(rules[0], refused)).toBe(false);
    }
  });

  it('permits setns only to join a user, network, PID or mount namespace', () => {
    const rules = rulesFor('setns');
    expect(rules.every((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.args?.length === 1)).toBe(true);
    expect(rules.map((rule) => rule.args![0])).toEqual(
      [CLONE_NEWUSER, CLONE_NEWNET, CLONE_NEWPID, CLONE_NEWNS].map((value) => ({ index: 1, value, op: 'SCMP_CMP_EQ' }))
    );
  });

  it('answers clone3 with ENOSYS: its flags sit in a struct a filter cannot read', () => {
    const rules = rulesFor('clone3');
    expect(rules).toEqual([expect.objectContaining({ action: 'SCMP_ACT_ERRNO', errnoRet: ENOSYS })]);
  });

  it('restricts personality to the execution domains libc sets', () => {
    const values = rulesFor('personality').map((rule) => {
      expect(rule.action).toBe('SCMP_ACT_ALLOW');
      expect(rule.args).toHaveLength(1);
      expect(rule.args![0].index).toBe(0);
      expect(rule.args![0].op).toBe('SCMP_CMP_EQ');
      return rule.args![0].value;
    });
    expect(values).toEqual([0, 0x8, 0x20000, 0x20008, 0xffffffff]);
  });
});
