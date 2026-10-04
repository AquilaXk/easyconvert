import fs from 'node:fs';
import path from 'node:path';

/**
 * Safely resolves an executable binary path by checking:
 * 1. An explicit environment variable override (e.g. QPDF_PATH, SOFFICE_PATH, VERAPDF_PATH)
 * 2. Standard system candidate locations
 * 3. The process PATH directory entries via stat/existsSync (no child process spawned)
 */
export function resolveBinaryPath(
  envVarName: string,
  candidates: string[],
  binName: string
): string | null {
  const custom = process.env[envVarName];
  if (custom !== undefined) {
    return custom && fs.existsSync(custom) ? custom : null;
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const fullPath = path.join(dir, binName);
    try {
      if (fs.existsSync(fullPath)) {
        return fullPath;
      }
    } catch {
      // Ignore directory access errors
    }
  }
  return null;
}
