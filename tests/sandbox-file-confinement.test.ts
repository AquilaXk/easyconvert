import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  confinementRefusal,
  executeSandboxedBinary,
  getUnshareCapability,
  resetUnshareCapabilityCache,
  resolveSandboxedCommand,
  withoutProcHideNotice,
} from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';
import { skipUnless } from './helpers/strict-skip';

/**
 * What a sandboxed program may do to the files of the host, observed from inside the program (a few lines of Node). The tenants' stored
 * files and the directories of the other jobs are stood in for by directories of this test; each refusal has a control, the same script
 * run without a work directory (today's access) or outside the sandbox, which must succeed, or the refusal proves nothing.
 */

const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;
const UNSHARE_PROBE_TIMEOUT_MS = 2_000;
/** The prefix of the Node binary the scripts run under: its libraries sit beside it, and a developer machine keeps it outside the system paths. */
const NODE_PREFIX = path.dirname(path.dirname(process.execPath));

function canConfine(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    execFileSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore', timeout: UNSHARE_PROBE_TIMEOUT_MS });
  } catch {
    return false;
  }
  return getUnshareCapability().confinesFiles;
}

/** What the program tries on `other` (the directory of another job) and `storage` (a tenant's stored files), and what it does in its own directory. */
const SCRIPT = `
const fs = require('node:fs');
const path = require('node:path');
const [own, other, storage] = process.argv.slice(1);
const attempt = (action) => { try { const value = action(); return value === undefined ? 'ok' : value; } catch (err) { return err.code; } };
const result = {
  readOther: attempt(() => fs.readFileSync(path.join(other, 'secret'), 'utf8')),
  overwriteOther: attempt(() => fs.writeFileSync(path.join(other, 'victim'), 'overwritten')),
  appendOther: attempt(() => fs.appendFileSync(path.join(other, 'victim'), 'more')),
  truncateOther: attempt(() => fs.truncateSync(path.join(other, 'victim'), 0)),
  createInOther: attempt(() => fs.writeFileSync(path.join(other, 'created'), 'x')),
  removeFromOther: attempt(() => fs.unlinkSync(path.join(other, 'victim'))),
  renameInOther: attempt(() => fs.renameSync(path.join(other, 'secret'), path.join(other, 'renamed'))),
  linkFromOther: attempt(() => fs.linkSync(path.join(other, 'secret'), path.join(own, 'stolen'))),
  moveOtherIntoOwn: attempt(() => fs.renameSync(path.join(other, 'secret'), path.join(own, 'stolen'))),
  listOther: attempt(() => fs.readdirSync(other).join(',')),
  readStorage: attempt(() => fs.readFileSync(path.join(storage, 'tenant', 'document.pdf'), 'utf8')),
  overwriteStorage: attempt(() => fs.writeFileSync(path.join(storage, 'tenant', 'document.pdf'), 'gone')),
  truncateStorage: attempt(() => fs.truncateSync(path.join(storage, 'tenant', 'document.pdf'), 0)),
  listTemp: attempt(() => fs.readdirSync(path.dirname(own)).length > 0 ? 'listed' : 'empty'),
  ownWrite: attempt(() => fs.writeFileSync(path.join(own, 'out.bin'), 'mine')),
  ownRead: attempt(() => fs.readFileSync(path.join(own, 'out.bin'), 'utf8')),
  ownTruncate: attempt(() => fs.truncateSync(path.join(own, 'out.bin'), 2)),
  ownMkdirAndRename: attempt(() => { fs.mkdirSync(path.join(own, 'sub')); fs.renameSync(path.join(own, 'out.bin'), path.join(own, 'sub', 'moved.bin')); fs.linkSync(path.join(own, 'sub', 'moved.bin'), path.join(own, 'link.bin')); }),
  ownList: attempt(() => fs.readdirSync(own).sort().join(',')),
  ownRemove: attempt(() => fs.rmSync(path.join(own, 'sub'), { recursive: true })),
  tmpdirIsOwn: process.env.TMPDIR === own && process.env.HOME === own ? 'ok' : process.env.TMPDIR + ' ' + process.env.HOME,
  writeTmpdir: attempt(() => fs.writeFileSync(path.join(process.env.TMPDIR, 'scratch.tmp'), 't')),
  readSystem: attempt(() => fs.readFileSync('/etc/passwd').length > 0 ? 'ok' : 'empty'),
  listSystem: attempt(() => fs.readdirSync('/usr/bin').length > 0 ? 'ok' : 'empty'),
  writeSystem: attempt(() => fs.writeFileSync('/etc/easyconvert-test', 'x')),
  devNull: attempt(() => fs.writeFileSync('/dev/null', 'x')),
  urandom: attempt(() => { const fd = fs.openSync('/dev/urandom', 'r'); try { return fs.readSync(fd, Buffer.alloc(8), 0, 8, null) === 8 ? 'ok' : 'short'; } finally { fs.closeSync(fd); } }),
  ownProc: attempt(() => fs.readFileSync('/proc/self/status').length > 0 ? 'ok' : 'empty'),
  meminfo: attempt(() => fs.readFileSync('/proc/meminfo').length > 0 ? 'ok' : 'empty'),
};
console.log(JSON.stringify(result));
`;

/** What a run that is not confined sees: every attempt on the other directories goes through. */
const UNCONFINED_ON_OTHERS = {
  readOther: 'top secret',
  overwriteOther: 'ok',
};

const CONFINED_OTHERS = {
  readOther: 'EACCES',
  overwriteOther: 'EACCES',
  appendOther: 'EACCES',
  truncateOther: 'EACCES',
  createInOther: 'EACCES',
  removeFromOther: 'EACCES',
  renameInOther: 'EACCES',
  // A link out of a directory the program has no REFER right on is refused with EXDEV, as the kernel answers a cross-tree link.
  linkFromOther: expect.stringMatching(/^(EACCES|EXDEV)$/),
  moveOtherIntoOwn: 'EACCES',
  listOther: 'EACCES',
  readStorage: 'EACCES',
  overwriteStorage: 'EACCES',
  truncateStorage: 'EACCES',
  listTemp: 'EACCES',
};

const OWN_WORK_AND_SYSTEM = {
  ownWrite: 'ok',
  ownRead: 'mine',
  ownTruncate: 'ok',
  ownMkdirAndRename: 'ok',
  ownList: 'link.bin,sub',
  ownRemove: 'ok',
  tmpdirIsOwn: 'ok',
  writeTmpdir: 'ok',
  readSystem: 'ok',
  listSystem: 'ok',
  writeSystem: expect.stringMatching(/^(EACCES|EROFS)$/),
  devNull: 'ok',
  urandom: 'ok',
  ownProc: 'ok',
  meminfo: 'ok',
};

// skip-ok: the confinement is a Landlock ruleset (Linux 6.2 or later) made by pid-init; skipUnless fails the run under ORACLE_STRICT_MODE=1 without it.
describe.skipIf(skipUnless('unprivileged namespaces, pid-init and Landlock version 3 (the confinement of the files of a run)', canConfine()))(
  'a sandboxed program is confined to the directory of its job',
  () => {
    let scratch: string;
    let own: string;
    let other: string;
    let storage: string;

    beforeEach(() => {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'file-confinement-'));
      own = path.join(scratch, 'job-own');
      other = path.join(scratch, 'job-other');
      storage = path.join(scratch, 'storage');
      for (const directory of [own, other, path.join(storage, 'tenant')]) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(other, 'secret'), 'top secret');
      fs.writeFileSync(path.join(other, 'victim'), 'intact');
      fs.writeFileSync(path.join(storage, 'tenant', 'document.pdf'), 'a tenant document');
    });

    afterEach(() => {
      fs.rmSync(scratch, { recursive: true, force: true });
      vi.unstubAllEnvs();
      resetUnshareCapabilityCache();
    });

    const run = async (options: Parameters<typeof executeSandboxedBinary>[2] = {}): Promise<Record<string, string>> => {
      const result = await executeSandboxedBinary(process.execPath, ['-e', SCRIPT, own, other, storage], {
        timeoutMs: CHILD_TIMEOUT_MS,
        readDirs: [NODE_PREFIX],
        ...options,
      });
      return JSON.parse(result.stdout.toString('utf-8'));
    };

    it(
      'control: a run that names no work directory reads, overwrites and lists what other jobs and tenants have (the access every run had)',
      async () => {
        const seen = await run();
        expect(seen).toMatchObject(UNCONFINED_ON_OTHERS);
        expect(seen.readStorage).toBe('a tenant document');
        expect(seen.truncateStorage).toBe('ok');
        expect(seen.listTemp).toBe('listed');
      },
      TEST_TIMEOUT_MS
    );

    it(
      'cannot read, overwrite, truncate, create, remove, rename, link or list the files of another job or of a tenant, and works in its own directory and in the system',
      async () => {
        const seen = await run({ workDir: own });
        expect(seen).toMatchObject({ ...CONFINED_OTHERS, ...OWN_WORK_AND_SYSTEM });
        // Nothing of the other job or the tenant changed, whatever the attempts reported.
        expect(fs.readFileSync(path.join(other, 'secret'), 'utf8')).toBe('top secret');
        expect(fs.readFileSync(path.join(other, 'victim'), 'utf8')).toBe('intact');
        expect(fs.readdirSync(other).sort()).toEqual(['secret', 'victim']);
        expect(fs.readFileSync(path.join(storage, 'tenant', 'document.pdf'), 'utf8')).toBe('a tenant document');
        expect(fs.existsSync(path.join(own, 'stolen'))).toBe(false);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'is confined the same way outside a PID namespace of its own',
      async () => {
        const seen = await run({ workDir: own, sandboxOptions: { pidNamespace: false } });
        expect(seen).toMatchObject({ ...CONFINED_OTHERS, ...OWN_WORK_AND_SYSTEM });
      },
      TEST_TIMEOUT_MS
    );

    it(
      'with `workDir: null` (a filter on standard input and output) writes no file anywhere but /dev/null, and still runs',
      async () => {
        const seen = await run({ workDir: null, cwd: scratch });
        expect(seen).toMatchObject({ ...CONFINED_OTHERS, ownWrite: 'EACCES', readSystem: 'ok', devNull: 'ok', ownProc: 'ok' });
      },
      TEST_TIMEOUT_MS
    );

    it(
      'writes below `writeDirs` and reads below `readDirs`, and below nothing else',
      async () => {
        const profile = path.join(scratch, 'profile');
        fs.mkdirSync(profile);
        const script = `
          const fs = require('node:fs');
          const [profile, other, models] = process.argv.slice(1);
          const attempt = (action) => { try { return action() ?? 'ok'; } catch (err) { return err.code; } };
          console.log(JSON.stringify({
            profileWrite: attempt(() => fs.writeFileSync(profile + '/registry.xcu', 'p')),
            modelRead: attempt(() => fs.readFileSync(models + '/m.onnx', 'utf8')),
            modelWrite: attempt(() => fs.writeFileSync(models + '/m.onnx', 'x')),
            otherRead: attempt(() => fs.readFileSync(other + '/secret', 'utf8')),
          }));
        `;
        const models = path.join(scratch, 'models');
        fs.mkdirSync(models);
        fs.writeFileSync(path.join(models, 'm.onnx'), 'weights');
        const result = await executeSandboxedBinary(process.execPath, ['-e', script, profile, other, models], {
          timeoutMs: CHILD_TIMEOUT_MS,
          workDir: own,
          writeDirs: [profile],
          readDirs: [NODE_PREFIX, models],
        });
        expect(JSON.parse(result.stdout.toString('utf-8'))).toEqual({ profileWrite: 'ok', modelRead: 'weights', modelWrite: 'EACCES', otherRead: 'EACCES' });
      },
      TEST_TIMEOUT_MS
    );

    it(
      'starts the program in its work directory when the caller names no other',
      async () => {
        const result = await executeSandboxedBinary(process.execPath, ['-e', 'console.log(process.cwd())'], { timeoutMs: CHILD_TIMEOUT_MS, workDir: own, readDirs: [NODE_PREFIX] });
        expect(result.stdout.toString('utf-8').trim()).toBe(fs.realpathSync(own));
      },
      TEST_TIMEOUT_MS
    );

    it(
      'refuses a work directory that holds the files of other jobs: the root and the temporary directory itself',
      () => {
        for (const workDir of ['/', os.tmpdir(), `${os.tmpdir()}/`]) {
          expect(() => resolveSandboxedCommand('/bin/true', [], { networkIsolated: true, workDir })).toThrow(/directory of one job/);
        }
        expect(() => resolveSandboxedCommand('/bin/true', [], { networkIsolated: true, workDir: 'relative/dir' })).toThrow(/absolute path/);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'SANDBOX_CONFINE_FILES=false runs the program as every run ran before',
      async () => {
        vi.stubEnv('SANDBOX_CONFINE_FILES', 'false');
        const seen = await run({ workDir: own });
        expect(seen).toMatchObject(UNCONFINED_ON_OTHERS);
      },
      TEST_TIMEOUT_MS
    );

    describe('under STRICT_SANDBOX', () => {
      beforeEach(() => vi.stubEnv('STRICT_SANDBOX', 'true'));

      it(
        'confines the run the same way',
        async () => {
          const seen = await run({ workDir: own });
          expect(seen).toMatchObject({ ...CONFINED_OTHERS, ...OWN_WORK_AND_SYSTEM });
        },
        TEST_TIMEOUT_MS
      );

      it(
        'refuses, before it starts anything, a run that names no work directory',
        async () => {
          await expect(run()).rejects.toBeInstanceOf(SandboxUnavailableError);
          await expect(run()).rejects.toThrow(/does not name the directory of its job/);
          expect(() => resolveSandboxedCommand('/bin/true', [], { networkIsolated: true })).toThrow(SandboxUnavailableError);
        },
        TEST_TIMEOUT_MS
      );

      it(
        'refuses a run when the host has no pid-init to confine it with',
        async () => {
          vi.stubEnv('PID_INIT_PATH', '');
          resetUnshareCapabilityCache();
          await expect(run({ workDir: own })).rejects.toBeInstanceOf(SandboxUnavailableError);
          await expect(run({ workDir: own })).rejects.toThrow(/cannot confine the files/);
        },
        TEST_TIMEOUT_MS
      );

      it(
        'refuses a run that asks for the PID namespace of `unshare -p`, which pid-init does not confine',
        async () => {
          await expect(run({ workDir: own, sandboxOptions: { pidNamespace: true } })).rejects.toBeInstanceOf(SandboxUnavailableError);
          await expect(run({ workDir: own, sandboxOptions: { pidNamespace: true } })).rejects.toThrow(/cannot confine the files/);
        },
        TEST_TIMEOUT_MS
      );
    });
  }
);

describe('the refusal of a pid-init that could not confine a run it was told to', () => {
  const refused = (code: number | null, text: string) => confinementRefusal(code, Buffer.from(text));

  it('reads the reason from the first line of the standard error, for the status pid-init refuses with', () => {
    expect(refused(125, 'pid-init: cannot confine: a rule could not be added\n')).toMatch(/^Strict sandbox: .*not started \(a rule could not be added\)/);
  });

  it('is not fooled by a program that exits 125 on its own, or by another status', () => {
    expect(refused(125, 'some program failed\n')).toBeNull();
    expect(refused(1, 'pid-init: cannot confine: x\n')).toBeNull();
    expect(refused(null, '')).toBeNull();
  });

  it('takes the notices of a run that went unconfined off the start of its standard error, and keeps the rest', () => {
    const output = withoutProcHideNotice(Buffer.from('pid-init: files not confined: Landlock version 2 cannot refuse a truncate\npid-init: /proc not hidden: the kernel has no Landlock\nthe program said this\n'));
    expect(output.toString('utf-8')).toBe('the program said this\n');
  });
});

describe('a stand-in pid-init that cannot confine (the host has no Landlock after a good probe)', () => {
  const standIn: { dir: string; program: string } = { dir: '', program: '' };

  beforeEach(() => {
    standIn.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-init-stand-in-'));
    standIn.program = path.join(standIn.dir, 'pid-init');
    fs.mkdirSync(path.join(standIn.dir, 'job'));
    // Answers the probes as a host that can, then refuses or warns the way the real one does when the ruleset fails at the start of a run.
    fs.writeFileSync(
      standIn.program,
      `#!/bin/sh
for argument in "$@"; do
  if [ "$argument" = "--check" ]; then exit 0; fi
done
case " $* " in
  *" --require "*) echo "pid-init: cannot confine: a rule could not be added" >&2; exit 125 ;;
esac
echo "pid-init: files not confined: a rule could not be added" >&2
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
      { mode: 0o755 }
    );
    vi.stubEnv('PID_INIT_PATH', standIn.program);
    resetUnshareCapabilityCache();
  });

  afterEach(() => {
    fs.rmSync(standIn.dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    resetUnshareCapabilityCache();
  });

  // skip-ok: needs unprivileged user and network namespaces, a kernel setting; skipUnless fails the run under ORACLE_STRICT_MODE=1.
  describe.skipIf(skipUnless('unprivileged user and network namespaces (unshare -r -n)', process.platform === 'linux' && canUnshare()))('', () => {
    it(
      'is refused with SandboxUnavailableError under STRICT_SANDBOX, and the program does not run',
      async () => {
        vi.stubEnv('STRICT_SANDBOX', 'true');
        const marker = path.join(standIn.dir, 'ran');
        await expect(
          executeSandboxedBinary('/bin/sh', ['-c', `echo ran > ${marker}`], { timeoutMs: CHILD_TIMEOUT_MS, workDir: standIn.dir + '/job' })
        ).rejects.toThrow(SandboxUnavailableError);
        expect(fs.existsSync(marker)).toBe(false);
      },
      TEST_TIMEOUT_MS
    );

    it(
      'runs the program without the notice in its output outside STRICT_SANDBOX',
      async () => {
        const result = await executeSandboxedBinary('/bin/sh', ['-c', 'echo out; echo err >&2'], { timeoutMs: CHILD_TIMEOUT_MS, workDir: standIn.dir + '/job' });
        expect({ out: result.stdout.toString('utf-8'), err: result.stderr.toString('utf-8') }).toEqual({ out: 'out\n', err: 'err\n' });
      },
      TEST_TIMEOUT_MS
    );
  });
});

function canUnshare(): boolean {
  try {
    execFileSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore', timeout: UNSHARE_PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
