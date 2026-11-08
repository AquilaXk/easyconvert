import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LibreOfficePoolManager, standaloneProfileArguments } from '../src/worker/libreoffice-pool';
import { writeKeepExcelObjectsSetting, writeOfficeProfile } from '../src/worker/libreoffice-profile';
import type { SandboxedExecutionOptions, SandboxedExecutionResult } from '../src/lib/security/process-sandbox';

/**
 * Every office suite run starts from the fixed profile: macros off, links never updated. The settings are read back from the file the suite
 * reads (`user/registrymodifications.xcu`) at the moment the program is started, in the standalone run, in a pool slot, and in the
 * readiness probe; `tests/office-import-filters.test.ts` checks the names against the schema of the installed suite.
 */

const SETTINGS = [
  ['/org.openoffice.Office.Common/Security/Scripting', 'MacroSecurityLevel', '3'],
  ['/org.openoffice.Office.Common/Security/Scripting', 'DisableMacrosExecution', 'true'],
  ['/org.openoffice.Office.Common/Security/Scripting', 'DisableActiveContent', 'true'],
  ['/org.openoffice.Office.Common/Security/Scripting', 'BlockUntrustedRefererLinks', 'true'],
  ['/org.openoffice.Office.Calc/Content/Update', 'Link', '2'],
  ['/org.openoffice.Office.Writer/Content/Update', 'Link', '2'],
] as const;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixed-profile-'));
  made.push(dir);
  return dir;
};

const registry = (profileRoot: string): string => fs.readFileSync(path.join(profileRoot, 'user', 'registrymodifications.xcu'), 'utf-8');

function expectFixedSettings(xcu: string): void {
  for (const [section, name, value] of SETTINGS) {
    expect(xcu, `${section} ${name}`).toContain(`<item oor:path="${section}"><prop oor:name="${name}" oor:op="fuse"><value>${value}</value></prop></item>`);
  }
}

describe('the fixed office profile', () => {
  it('turns macros off and never updates links', () => {
    const root = scratch();
    writeOfficeProfile(root);
    const xcu = registry(root);
    expectFixedSettings(xcu);
    expect(xcu).not.toContain('ExcelToCalc');
    expect(fs.statSync(path.join(root, 'user', 'registrymodifications.xcu')).mode & 0o777).toBe(0o600);
  });

  it('keeps the setting for embedded Excel objects beside the fixed ones, and does not drop them', () => {
    const root = scratch();
    writeKeepExcelObjectsSetting(root);
    const xcu = registry(root);
    expectFixedSettings(xcu);
    expect(xcu).toMatch(/<prop oor:name="ExcelToCalc" oor:op="fuse"><value>false<\/value><\/prop>/);
  });

  it('is written for the standalone run of every source, with the import filter of a declared format and none for a detected one', () => {
    const word = scratch();
    expect(standaloneProfileArguments(word, {}, 'docx')).toEqual([`-env:UserInstallation=file://${word}/user`, '--infilter=MS Word 2007 XML']);
    expectFixedSettings(registry(`${word}/user`));
    const html = scratch();
    expect(standaloneProfileArguments(html, {}, 'html')).toEqual([`-env:UserInstallation=file://${html}/user`]);
    expectFixedSettings(registry(`${html}/user`));
    const keep = scratch();
    standaloneProfileArguments(keep, { keepEmbeddedExcelObjects: true }, 'ppt');
    expect(registry(`${keep}/user`)).toContain('ExcelToCalc');
  });

  it('is written again before every job of a pool slot, so one job cannot hand a changed profile to the next', async () => {
    const seen: string[] = [];
    let slotProfile = '';
    const executor = async (_binary: string, args: string[], _options?: SandboxedExecutionOptions): Promise<SandboxedExecutionResult> => {
      const installation = args.find((arg) => arg.startsWith('-env:UserInstallation=file://'))!.slice('-env:UserInstallation=file://'.length);
      slotProfile = installation;
      if (args.includes('--convert-to')) {
        seen.push(registry(installation));
        // The suite writes its settings back when it ends: this job leaves macros allowed and links always updated.
        fs.writeFileSync(path.join(installation, 'user', 'registrymodifications.xcu'), registry(installation).replace('<value>3</value>', '<value>0</value>').replace(/<value>2<\/value>/g, '<value>0</value>'));
        fs.writeFileSync(path.join(args[args.indexOf('--outdir') + 1], 'input.pdf'), '%PDF-1.4\n');
      }
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
    };
    const pool = new LibreOfficePoolManager({ minWorkers: 0, maxWorkers: 1, enabled: true, sofficePath: '/mock/soffice', executor, readinessProbe: false });
    try {
      await pool.convert(Buffer.from('one'), 'docx', 'pdf', {}, 'one.docx');
      expect(registry(slotProfile)).toContain('<value>0</value>');
      await pool.convert(Buffer.from('two'), 'docx', 'pdf', {}, 'two.docx');
      expect(seen).toHaveLength(2);
      for (const xcu of seen) expectFixedSettings(xcu);
    } finally {
      await pool.shutdown();
    }
  });

  it('is in place before the pre-warm run and the conversion of a pool slot, and the conversion names the import filter', async () => {
    const calls: Array<{ args: string[]; profile: string | undefined }> = [];
    const executor = async (_binary: string, args: string[], _options?: SandboxedExecutionOptions): Promise<SandboxedExecutionResult> => {
      const installation = args.find((arg) => arg.startsWith('-env:UserInstallation=file://'))?.slice('-env:UserInstallation=file://'.length);
      calls.push({ args, profile: installation && fs.existsSync(path.join(installation, 'user', 'registrymodifications.xcu')) ? registry(installation) : undefined });
      const outdir = args[args.indexOf('--outdir') + 1];
      if (outdir) fs.writeFileSync(path.join(outdir, 'input.pdf'), '%PDF-1.4\n');
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0, durationMs: 0, sandboxed: true, sandboxType: 'host' };
    };
    const pool = new LibreOfficePoolManager({ minWorkers: 0, maxWorkers: 1, enabled: true, sofficePath: '/mock/soffice', executor, readinessProbe: false });
    try {
      await pool.convert(Buffer.from('word'), 'docx', 'pdf', {}, 'letter.docx');
      expect(calls.length).toBeGreaterThanOrEqual(2);
      for (const call of calls) {
        expect(call.profile, `profile when ${call.args.slice(0, 6).join(' ')} starts`).toBeDefined();
        expectFixedSettings(call.profile!);
      }
      const conversion = calls.find((call) => call.args.includes('--convert-to'))!;
      expect(conversion.args).toContain('--infilter=MS Word 2007 XML');
      expect(conversion.args.indexOf('--infilter=MS Word 2007 XML')).toBeLessThan(conversion.args.indexOf('--convert-to'));
    } finally {
      await pool.shutdown();
    }
  });
});
