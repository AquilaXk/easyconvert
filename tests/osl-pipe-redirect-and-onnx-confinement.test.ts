import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as processSandbox from '../src/lib/security/process-sandbox';
import {
  executeSandboxedBinary,
  libreOfficeSandboxPipeScope,
  resolveSandboxedCommand,
} from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';
import { LibreOfficePoolManager, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';
import {
  onnxHelperReadScope,
  OnnxOcrPool,
  resolveChildEntry,
} from '../src/lib/conversions/ocr-onnx-helper';
import { skipUnless } from './helpers/strict-skip';

const C_COMPILER = process.env.CC ?? 'cc';
const RUN_HANG_GUARD_MS = 30_000;
const ROOT = path.resolve(__dirname, '..');
const hasCompiler = spawnSync(C_COMPILER, ['--version'], { stdio: 'ignore' }).status === 0;
const hasNamespaces =
  process.platform === 'linux' && spawnSync('unshare', ['-r', '-n', '--', 'true'], { stdio: 'ignore' }).status === 0;

const scratch = hasCompiler && hasNamespaces ? fs.mkdtempSync(path.join(os.tmpdir(), 'osl-pipe-confine-')) : '';
const library = path.join(scratch, 'liboslpipe.so');
const pidInit = path.join(scratch, 'pid-init');
const probe = path.join(scratch, 'probe');
const deepJobParent = path.join(
  scratch,
  'very_long_sandbox_parent_segment_0123456789abcdef_0123456789abcdef_0123456789abcdef'
);
const deepJob = path.join(deepJobParent, 'job_12345678');

function prepareConfinementHarness(): boolean {
  if (scratch === '') return false;
  const built = [
    spawnSync(path.join(ROOT, 'native', 'osl-pipe-redirect', 'build.sh'), [library], { encoding: 'utf8' }),
    spawnSync(path.join(ROOT, 'native', 'pid-init', 'build.sh'), [pidInit], { encoding: 'utf8' }),
  ];
  for (const build of built) {
    if (build.status !== 0) throw new Error(`build failed: ${build.stderr}${build.stdout}`);
  }
  const probeSource = `
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

int main(void) {
  const char *sock_path = "/tmp/OSL_PIPE_0_SingleOfficeIPC_0123456789abcdef0123456789abcdef";
  const char *victim = getenv("VICTIM_FILE");
  int srv = socket(AF_UNIX, SOCK_STREAM, 0);
  if (srv < 0) return 10;
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof addr);
  addr.sun_family = AF_UNIX;
  snprintf(addr.sun_path, sizeof addr.sun_path, "%s", sock_path);
  socklen_t len = (socklen_t)(sizeof(sa_family_t) + strlen(addr.sun_path) + 1);
  if (bind(srv, (struct sockaddr *)&addr, len) != 0) {
    printf("bind:%s\\n", errno == EACCES ? "EACCES" : strerror(errno));
    close(srv);
    return 1;
  }
  struct stat st;
  if (lstat(sock_path, &st) != 0 || !S_ISSOCK(st.st_mode)) {
    puts("lstat:fail");
    close(srv);
    return 2;
  }
  if (chmod(sock_path, 0600) != 0) {
    puts("chmod:fail");
    close(srv);
    return 3;
  }
  int cli = socket(AF_UNIX, SOCK_STREAM, 0);
  if (cli < 0 || listen(srv, 1) != 0 || connect(cli, (struct sockaddr *)&addr, len) != 0) {
    printf("connect:%s\\n", strerror(errno));
    if (cli >= 0) close(cli);
    close(srv);
    return 4;
  }
  close(cli);
  close(srv);
  if (unlink(sock_path) != 0) {
    puts("unlink:fail");
    return 5;
  }
  int victim_unlink = victim ? unlink(victim) : 0;
  int victim_err = victim_unlink == 0 ? 0 : errno;
  printf("ok victim_unlink=%s\\n", victim_err == EACCES ? "EACCES" : strerror(victim_err));
  return victim_err == EACCES ? 0 : 6;
}
`;
  const srcPath = path.join(scratch, 'probe.c');
  fs.writeFileSync(srcPath, probeSource);
  const compiled = spawnSync(C_COMPILER, ['-Wall', '-Wextra', '-o', probe, srcPath], { encoding: 'utf8' });
  if (compiled.status !== 0) throw new Error(`probe compile failed: ${compiled.stderr}`);
  fs.mkdirSync(deepJob, { recursive: true });
  return spawnSync('unshare', ['-r', '-n', '--', pidInit, '--check', '--confine'], { timeout: RUN_HANG_GUARD_MS }).status === 0;
}

const confines = prepareConfinementHarness();

afterAll(() => {
  if (scratch !== '') fs.rmSync(scratch, { recursive: true, force: true });
});

describe('LibreOffice OSL_PIPE and ONNX OCR readDirs confinement scope', () => {
  it('removes OFFICE_PIPE_DIR from process-sandbox and passes zero socketDirs from LibreOfficePoolManager', async () => {
    expect('OFFICE_PIPE_DIR' in processSandbox).toBe(false);

    const calls: Array<{ args: string[]; socketDirs?: readonly string[]; env?: Record<string, string> }> = [];
    const executor: SandboxedProcessRunner = vi.fn(async (_bin, args, opts) => {
      calls.push({ args, socketDirs: opts?.socketDirs, env: opts?.env });
      const outIdx = args.indexOf('--outdir');
      if (outIdx !== -1 && args[outIdx + 1]) {
        const inputFile = args[args.length - 1];
        const stem = path.basename(inputFile, path.extname(inputFile));
        fs.writeFileSync(path.join(args[outIdx + 1], `${stem}.pdf`), '%PDF-1.4\n%%EOF\n');
      }
      return { stdout: Buffer.from(''), stderr: Buffer.from(''), exitCode: 0, durationMs: 1, sandboxed: true, sandboxType: 'host' as const };
    });

    const pool = new LibreOfficePoolManager({
      sofficePath: '/mock/soffice',
      enabled: true,
      executor,
      readinessProbe: true,
      minWorkers: 0,
      maxWorkers: 1,
    });
    try {
      const result = await pool.convert(Buffer.from('Hello'), 'txt', 'pdf', {}, 'hello.txt');
      expect(result?.engineUsed).toBe('native-soffice-pool');
      expect(calls.length).toBeGreaterThanOrEqual(3); // readiness probe + warm-up + convert
      for (const call of calls) {
        expect(call.socketDirs).toBeUndefined();
        expect(call.env?.TMPDIR).toBeDefined();
      }
    } finally {
      await pool.shutdown();
    }
  });

  it('rejects non-job directories and missing explicit library paths in libreOfficeSandboxPipeScope', () => {
    expect(() => libreOfficeSandboxPipeScope('/')).toThrow(SandboxUnavailableError);
    expect(() => libreOfficeSandboxPipeScope(os.tmpdir())).toThrow(SandboxUnavailableError);
    expect(() => libreOfficeSandboxPipeScope('relative/dir')).toThrow(SandboxUnavailableError);
    expect(() => libreOfficeSandboxPipeScope('/tmp/bad\0dir')).toThrow(SandboxUnavailableError);

    if (process.platform === 'linux') {
      expect(() =>
        libreOfficeSandboxPipeScope(path.join(os.tmpdir(), 'valid-lo-job-dir'), {
          libraryPath: path.join(os.tmpdir(), 'definitely-missing-osl-pipe.so'),
        })
      ).toThrow(SandboxUnavailableError);
    }
  });

  it('excludes process.cwd(), /, and os.tmpdir() from onnxHelperReadScope', () => {
    const fakeEntry = { binary: process.execPath, args: [path.join(ROOT, 'tests', 'helpers', 'fake-onnx-child.cjs'), '--mode=ok'] };
    const modelDir = path.join(ROOT, 'tests', 'fixtures');
    const scope = onnxHelperReadScope(fakeEntry, modelDir);

    const resolvedCwd = fs.realpathSync(process.cwd());
    const resolvedTmp = path.resolve(os.tmpdir());
    expect(scope.readDirs).not.toContain(resolvedCwd);
    expect(scope.readDirs).not.toContain(process.cwd());
    expect(scope.readDirs).not.toContain('/');
    expect(scope.readDirs).not.toContain(resolvedTmp);
    expect(scope.readDirs).toContain(fs.realpathSync(modelDir));
    expect(scope.readDirs).toContain(fs.realpathSync(path.join(ROOT, 'package.json')));
    expect(scope.readDirs).toContain(fs.realpathSync(path.join(ROOT, 'node_modules')));

    const resolved = resolveChildEntry();
    expect(resolved).not.toBeNull();
    if (resolved) {
      const entryScope = onnxHelperReadScope(resolved, modelDir);
      expect(entryScope.readDirs).not.toContain(resolvedCwd);
      expect(entryScope.readDirs).not.toContain(process.cwd());
      expect(entryScope.readDirs).not.toContain('/');
      expect(entryScope.readDirs.length).toBeLessThanOrEqual(8);
    }
  });
});

// skip-ok: Landlock confinement checks require Linux 6.2+, user namespaces, and a C compiler; ORACLE_STRICT_MODE=1 fails if absent.
describe.skipIf(skipUnless('a C compiler, unprivileged namespaces and Landlock version 3 for OSL_PIPE confinement', confines))(
  'Linux Landlock confinement with OSL_PIPE redirect and narrow ONNX helper readDirs',
  () => {
    it('control without LD_PRELOAD fails bind on /tmp/OSL_PIPE_* under pid-init --confine --require', () => {
      const victim = path.join(os.tmpdir(), `osl-pipe-victim-${process.pid}-${Date.now()}`);
      fs.writeFileSync(victim, 'untouched');
      try {
        const run = spawnSync(
          'unshare',
          ['-r', '-n', '--', pidInit, '--confine', '--require', '--write', deepJob, '--read', probe, '--', 'env', `TMPDIR=${deepJob}`, `VICTIM_FILE=${victim}`, probe],
          { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }
        );
        expect(run.status).toBe(1);
        expect(run.stdout.trim()).toBe('bind:EACCES');
        expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
      } finally {
        fs.rmSync(victim, { force: true });
      }
    });

    it('redirects /tmp/OSL_PIPE_* into a >107-byte job dir via /proc/self/fd without granting /tmp unlink or socket rights', () => {
      expect(deepJob.length).toBeGreaterThan(107);
      const victim = path.join(os.tmpdir(), `osl-pipe-victim-${process.pid}-${Date.now()}`);
      fs.writeFileSync(victim, 'protected');
      try {
        const pipeScope = libreOfficeSandboxPipeScope(deepJob, { libraryPath: library });
        const envArgs = Object.entries({ ...pipeScope.env, VICTIM_FILE: victim }).map(([k, v]) => `${k}=${v}`);
        const readArgs = pipeScope.readDirs.flatMap((d) => ['--read', d]);
        const run = spawnSync(
          'unshare',
          ['-r', '-n', '--', pidInit, '--confine', '--require', '--write', deepJob, ...readArgs, '--read', probe, '--', 'env', ...envArgs, probe],
          { encoding: 'utf8', timeout: RUN_HANG_GUARD_MS }
        );
        expect({ status: run.status, out: run.stdout.trim(), err: run.stderr.trim() }).toEqual({
          status: 0,
          out: 'ok victim_unlink=EACCES',
          err: '',
        });
        expect(fs.readFileSync(victim, 'utf8')).toBe('protected');
        expect(fs.readdirSync(deepJob)).toEqual([]);
        expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('OSL_PIPE_'))).toEqual([]);
      } finally {
        fs.rmSync(victim, { force: true });
      }
    });

    const sofficeBin = ['/usr/bin/soffice', '/usr/local/bin/soffice'].find((p) => fs.existsSync(p)) ?? null;
    it.skipIf(skipUnless('LibreOffice binary (soffice) on Linux', sofficeBin !== null))(
      'converts a real document with soffice under pid-init --confine --require with zero socketDirs on /tmp',
      async () => {
        const jobDir = fs.mkdtempSync(path.join(scratch, 'lo-real-'));
        const profileDir = path.join(jobDir, 'profile');
        const inputTxt = path.join(jobDir, 'hello.txt');
        const victim = path.join(os.tmpdir(), `lo-victim-${process.pid}-${Date.now()}`);
        fs.mkdirSync(profileDir, { mode: 0o700 });
        fs.writeFileSync(inputTxt, 'Confined LibreOffice conversion check\n');
        fs.writeFileSync(victim, 'safe');
        try {
          const pipeScope = libreOfficeSandboxPipeScope(jobDir, { libraryPath: library });
          await executeSandboxedBinary(
            sofficeBin!,
            [
              '--headless',
              '--norestore',
              '--nofirststartwizard',
              '--nologo',
              `-env:UserInstallation=file://${profileDir}`,
              '--convert-to',
              'pdf',
              '--outdir',
              jobDir,
              inputTxt,
            ],
            {
              cwd: jobDir,
              workDir: jobDir,
              writeDirs: [profileDir],
              readDirs: [fs.realpathSync(inputTxt), ...pipeScope.readDirs],
              strictIsolation: true,
              networkIsolated: true,
              timeoutMs: 30_000,
              memoryLimitMb: 3328,
              env: { HOME: jobDir, SAL_USE_VCLPLUGIN: 'svp', ...pipeScope.env },
            }
          );
          const outPdf = fs.readFileSync(path.join(jobDir, 'hello.pdf'));
          expect(outPdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
          expect(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('OSL_PIPE_'))).toEqual([]);
          expect(fs.readFileSync(victim, 'utf8')).toBe('safe');
        } finally {
          fs.rmSync(victim, { force: true });
        }
      }
    );

    it('denies ONNX helper access to sibling workspace files in process.cwd() while allowing package.json and node_modules', async () => {
      const childScript = path.join(scratch, 'check-onnx-confinement.cjs');
      fs.writeFileSync(
        childScript,
        `
const fs = require('node:fs');
const path = require('node:path');
const repoRoot = ${JSON.stringify(ROOT)};
const attempt = (fn) => { try { fn(); return 'ok'; } catch (e) { return e && e.code ? e.code : String(e); } };
const report = {
  cwdReaddir: attempt(() => fs.readdirSync(repoRoot)),
  readmeRead: attempt(() => fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8')),
  packageRead: attempt(() => JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).name),
  onnxResolve: attempt(() => require.resolve('onnxruntime-node')),
  cwdInsideTmp: process.cwd().length > 0,
};
const frame = (header) => {
  const json = Buffer.from(JSON.stringify(header));
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32BE(json.length, 0);
  return Buffer.concat([prefix, json]);
};
process.stdout.write(frame({ type: 'ready' }));
let buf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.length < 8) return;
  const hLen = buf.readUInt32BE(0);
  const pLen = buf.readUInt32BE(4);
  if (buf.length < 8 + hLen + pLen) return;
  const req = JSON.parse(buf.toString('utf8', 8, 8 + hLen));
  const box = { x: 0, y: 0, width: req.width, height: req.height };
  const word = { text: JSON.stringify(report), confidence: 0.99, bbox: box };
  process.stdout.write(frame({ type: 'result', id: req.id, result: { lineBlocks: [{ text: word.text, bbox: box, words: [word] }] } }));
});
`
      );
      vi.stubEnv('PID_INIT_PATH', pidInit);
      vi.stubEnv('STRICT_SANDBOX', 'true');
      processSandbox.resetUnshareCapabilityCache();

      const modelDir = path.join(scratch, 'models');
      fs.mkdirSync(modelDir);
      const pool = new OnnxOcrPool({
        plan: { helpers: 1, threads: 1 },
        modelDir,
        entry: { binary: process.execPath, args: [childScript] },
      });
      try {
        const res = await pool.read(
          { width: 8, height: 6, rgb: new Uint8Array(8 * 6 * 3), detector: { width: 4, height: 4, rgb: new Uint8Array(48) } },
          { language: 'kor' }
        );
        const parsed = JSON.parse(res.text);
        expect(parsed).toEqual({
          cwdReaddir: 'EACCES',
          readmeRead: 'EACCES',
          packageRead: 'ok',
          onnxResolve: 'ok',
          cwdInsideTmp: true,
        });
        expect(() => resolveSandboxedCommand('/bin/true', [], { networkIsolated: true, workDir: deepJob })).not.toThrow();
      } finally {
        pool.shutdown();
        vi.unstubAllEnvs();
        processSandbox.resetUnshareCapabilityCache();
      }
    });
  }
);
