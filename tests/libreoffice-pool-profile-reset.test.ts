import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotARegularFileError } from '../src/lib/storage/errors';
import { LibreOfficePoolManager, type SandboxedProcessRunner } from '../src/worker/libreoffice-pool';

/**
 * The jobs of a pool slot share its profile directory, which the sandboxed suite may write to. Every job starts from a profile made again
 * (a copy of the one the readiness probe left, then the fixed settings), so what one job left in it neither reaches the next job nor makes
 * the host write through a link the suite planted.
 */

const SETTINGS = path.join('user', 'registrymodifications.xcu');
const pools: LibreOfficePoolManager[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const pool of pools.splice(0)) await pool.shutdown();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const result = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 1, sandboxed: true, sandboxType: 'host' as const };

/** The profile directory a run of the suite names with `-env:UserInstallation=file://`. */
function profileOf(args: string[]): string {
  return args.find((arg) => arg.startsWith('-env:UserInstallation=file://'))!.slice('-env:UserInstallation=file://'.length);
}

function newPool(executor: SandboxedProcessRunner, readinessProbe: boolean): LibreOfficePoolManager {
  const pool = new LibreOfficePoolManager({ maxWorkers: 1, minWorkers: 0, sofficePath: '/usr/bin/soffice', enabled: true, executor, readinessProbe });
  pools.push(pool);
  return pool;
}

function victimFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-profile-reset-'));
  scratch.push(dir);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'HOST FILE');
  return victim;
}

describe('the profile of a pool slot between two jobs', () => {
  it('is not written through a link the first job left at the settings file', async () => {
    const victim = victimFile();
    let sawLinkAtSecondJob = true;
    let jobs = 0;
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (!args.includes('--convert-to')) return result;
      jobs += 1;
      const profile = profileOf(args);
      if (jobs === 1) {
        fs.rmSync(path.join(profile, SETTINGS));
        fs.symlinkSync(victim, path.join(profile, SETTINGS));
      } else {
        sawLinkAtSecondJob = fs.lstatSync(path.join(profile, SETTINGS)).isSymbolicLink();
      }
      fs.writeFileSync(path.join(options!.cwd!, 'input.pdf'), '%PDF-1.7 out');
      return result;
    };
    const pool = newPool(executor, false);

    await pool.convert(Buffer.from('one'), 'docx', 'pdf', { timeoutMs: 5000 }, 'one.docx');
    await pool.convert(Buffer.from('two'), 'docx', 'pdf', { timeoutMs: 5000 }, 'two.docx');

    expect(fs.readFileSync(victim, 'utf8')).toBe('HOST FILE');
    expect(sawLinkAtSecondJob).toBe(false);
  });

  it('holds nothing a job left in it, and holds what the probe left', async () => {
    let jobs = 0;
    const seen: Array<{ leftover: boolean; fromProbe: boolean; settings: boolean }> = [];
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (args.includes('--help')) return result;
      const profile = profileOf(args);
      if (args.includes('probe.txt') || args.some((arg) => arg.endsWith('probe.txt'))) {
        fs.writeFileSync(path.join(profile, 'user', 'initialised-by-the-suite'), 'x');
        fs.writeFileSync(path.join(options!.cwd!, 'probe.pdf'), '%PDF-1.7 probe');
        return result;
      }
      jobs += 1;
      seen.push({
        leftover: fs.existsSync(path.join(profile, 'user', 'left-by-the-job')),
        fromProbe: fs.existsSync(path.join(profile, 'user', 'initialised-by-the-suite')),
        settings: fs.readFileSync(path.join(profile, SETTINGS), 'utf8').includes('DisableMacrosExecution'),
      });
      fs.writeFileSync(path.join(profile, 'user', 'left-by-the-job'), 'x');
      fs.writeFileSync(path.join(options!.cwd!, 'input.pdf'), '%PDF-1.7 out');
      return result;
    };
    const pool = newPool(executor, true);

    await pool.convert(Buffer.from('one'), 'docx', 'pdf', { timeoutMs: 5000 }, 'one.docx');
    await pool.convert(Buffer.from('two'), 'docx', 'pdf', { timeoutMs: 5000 }, 'two.docx');

    expect(jobs).toBe(2);
    expect(seen).toEqual([
      { leftover: false, fromProbe: true, settings: true },
      { leftover: false, fromProbe: true, settings: true },
    ]);
  });

  it('is removed with the pool, template included', async () => {
    let probeProfile = '';
    const executor: SandboxedProcessRunner = async (_bin, args, options) => {
      if (args.some((arg) => arg.endsWith('probe.txt'))) {
        probeProfile = profileOf(args);
        fs.writeFileSync(path.join(options!.cwd!, 'probe.pdf'), '%PDF-1.7 probe');
      }
      return result;
    };
    const pool = newPool(executor, true);
    await pool.convert(Buffer.from('one'), 'docx', 'pdf', { timeoutMs: 5000 }, 'one.docx').catch(() => null);
    expect(fs.existsSync(probeProfile)).toBe(true);

    await pool.shutdown();

    expect(fs.existsSync(probeProfile)).toBe(false);
  });
});

describe('the output of a pool job that is a link', () => {
  it('is refused, not copied to the destination of the result', () => {
    const victim = victimFile();
    const link = path.join(path.dirname(victim), 'input.pdf');
    fs.symlinkSync(victim, link);
    const destination = path.join(path.dirname(victim), 'result.pdf');
    const pool = newPool(async () => result, false);

    expect(() => (pool as any).buildPersistedResult(link, 'pdf', 'doc', Date.now(), { outputPath: destination }, {})).toThrow(NotARegularFileError);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
