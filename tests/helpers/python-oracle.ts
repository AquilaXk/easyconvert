import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getOracleToolPath } from './differential-oracle';

/**
 * Python packages used as independent oracles (python-docx for Word documents, ebooklib for EPUB packages). The
 * interpreter runs in isolated mode (`-I`), so nothing next to the inputs is imported.
 */

const PYTHON_TIMEOUT_MS = 60_000;
const PYTHON_HELPERS = path.join(__dirname, 'python');

export function pythonModuleAvailable(moduleName: string): boolean {
  const python = getOracleToolPath('python3');
  if (!python) return false;
  try {
    execFileSync(python, ['-I', '-c', `import ${moduleName}`], { stdio: 'ignore', timeout: PYTHON_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Runs a helper script of tests/helpers/python with `args` and parses its JSON output. */
export function runPythonHelper<T>(script: string, args: string[]): T {
  const python = getOracleToolPath('python3');
  if (!python) throw new Error('python3 is not available');
  const output = execFileSync(python, ['-I', path.join(PYTHON_HELPERS, script), ...args], { encoding: 'utf-8', timeout: PYTHON_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(output) as T;
}
