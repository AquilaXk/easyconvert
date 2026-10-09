import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

/**
 * LibreOffice as the reference converter: `soffice --convert-to` on a copy of the input in a throwaway directory
 * with its own profile. The caller reads the output (and any files LibreOffice writes next to it, such as the
 * pictures of an HTML export) inside `inspect`, before the directory is removed.
 */

const SOFFICE_TIMEOUT_MS = 180_000;

export interface SofficeOutput {
  /** Directory holding the converted file and any files written beside it. */
  directory: string;
  file: string;
  read(): Buffer;
  /** Bytes of a file written beside the output, or undefined. */
  sibling(name: string): Buffer | undefined;
}

export function sofficeConvert<T>(input: Buffer, inputName: string, target: string, inspect: (output: SofficeOutput) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soffice-ref-'));
  try {
    const source = path.join(dir, inputName);
    fs.writeFileSync(source, input);
    const out = path.join(dir, 'out');
    execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', target, '--outdir', out, source], {
      stdio: 'ignore',
      timeout: SOFFICE_TIMEOUT_MS,
    });
    const extension = target.split(':')[0];
    const file = path.join(out, `${path.parse(inputName).name}.${extension}`);
    return inspect({
      directory: out,
      file,
      read: () => fs.readFileSync(file),
      sibling: (name) => {
        const candidate = path.join(out, name);
        return fs.existsSync(candidate) ? fs.readFileSync(candidate) : undefined;
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
