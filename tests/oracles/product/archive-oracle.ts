import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  getOracleToolPath,
  requireOracleTool,
  OracleToolMissingError,
} from '../../helpers/differential-oracle';

export interface TarEntryInfo {
  path: string;
  size: number;
  mode: string;
}

export interface NativeArchiveVerificationResult {
  passed: boolean;
  tool: string;
  output: string;
  error?: string;
}

export interface NativeTarInspectionResult {
  passed: boolean;
  entries: TarEntryInfo[];
  output: string;
  error?: string;
}

export interface ArchiveEntryDigestsResult {
  matched: boolean;
  computedDigests: Record<string, string>;
  discrepancies: string[];
}

/**
 * Verifies archive integrity using native `7z t` CLI without using any production code.
 */
export function verifyArchiveWithNative7z(
  archiveBuffer: Buffer,
  formatHint?: string
): NativeArchiveVerificationResult {
  const sevenZipPath = requireOracleTool('7z');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-oracle-7z-'));
  const tempFile = path.join(tempDir, `archive.${formatHint || 'bin'}`);

  try {
    fs.writeFileSync(tempFile, archiveBuffer);
    const args = ['t', '-y'];
    if (formatHint) {
      args.push(`-t${formatHint}`);
    }
    args.push(tempFile);

    const output = execFileSync(sevenZipPath, args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const passed = output.includes('Everything is Ok') || output.includes('Ok');
    return {
      passed,
      tool: sevenZipPath,
      output,
    };
  } catch (err: any) {
    const errorOutput = (err?.stderr || '') + (err?.stdout || '');
    return {
      passed: false,
      tool: sevenZipPath,
      output: errorOutput,
      error: err?.message || 'Native 7z verification failed',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Inspects TAR archive headers and table of contents using native system `tar -tvf` CLI.
 */
export function inspectTarWithNativeTar(
  tarBuffer: Buffer
): NativeTarInspectionResult {
  const tarPath = requireOracleTool('tar');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-oracle-tar-'));
  const tempFile = path.join(tempDir, 'archive.tar');

  try {
    fs.writeFileSync(tempFile, tarBuffer);
    const output = execFileSync(tarPath, ['-tvf', tempFile], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const entries: TarEntryInfo[] = [];
    const lines = output.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      // Standard tar -tvf format:
      // -rw-r--r--  0 user group 1234 Oct  5 00:00 filename.txt
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6) {
        const mode = parts[0];
        // Size is typically part index 4 or 2 depending on tar dialect
        let size = 0;
        let entryPath = parts[parts.length - 1];

        for (let i = 1; i < parts.length - 1; i++) {
          if (/^\d+$/.test(parts[i]) && parseInt(parts[i], 10) > 0) {
            size = parseInt(parts[i], 10);
          }
        }

        entries.push({
          path: entryPath,
          size,
          mode,
        });
      }
    }

    return {
      passed: true,
      entries,
      output,
    };
  } catch (err: any) {
    const errorOutput = (err?.stderr || '') + (err?.stdout || '');
    return {
      passed: false,
      entries: [],
      output: errorOutput,
      error: err?.message || 'Native tar inspection failed',
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Recursively crawls extracted directory to compute SHA-256 digests for all files.
 */
function crawlAndComputeDigests(
  baseDir: string,
  currentDir: string = baseDir,
  digests: Record<string, string> = {}
): Record<string, string> {
  const items = fs.readdirSync(currentDir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(currentDir, item.name);
    if (item.isDirectory()) {
      crawlAndComputeDigests(baseDir, fullPath, digests);
    } else if (item.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
      const content = fs.readFileSync(fullPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      digests[relativePath] = hash;
    }
  }

  return digests;
}

/**
 * Extracts archive using native system tools (`tar -xf` or `7z x -y`) and compares
 * SHA-256 digests of each extracted file against expected digests.
 * Completely independent of production decompressors.
 */
export function verifyArchiveEntriesSha256(
  archiveBuffer: Buffer,
  expectedDigests: Record<string, string> | Map<string, string>,
  format: 'tar' | '7z' | 'zip' = 'tar'
): ArchiveEntryDigestsResult {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-oracle-extract-'));
  const extractDir = path.join(tempDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });

  const archivePath = path.join(tempDir, `input.${format}`);
  fs.writeFileSync(archivePath, archiveBuffer);

  const discrepancies: string[] = [];

  try {
    if (format === 'tar') {
      const tarPath = requireOracleTool('tar');
      execFileSync(tarPath, ['-xf', archivePath, '-C', extractDir], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      const sevenZipPath = requireOracleTool('7z');
      execFileSync(sevenZipPath, ['x', '-y', `-o${extractDir}`, archivePath], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const computedDigests = crawlAndComputeDigests(extractDir);
    const expectedMap: Record<string, string> = expectedDigests instanceof Map
      ? Object.fromEntries(expectedDigests.entries())
      : expectedDigests;

    // Check expected vs actual
    for (const [filePath, expectedHash] of Object.entries(expectedMap)) {
      const actualHash = computedDigests[filePath];
      if (!actualHash) {
        discrepancies.push(`Missing expected archive entry: ${filePath}`);
      } else if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
        discrepancies.push(
          `SHA-256 digest mismatch for ${filePath}: expected ${expectedHash}, computed ${actualHash}`
        );
      }
    }

    for (const filePath of Object.keys(computedDigests)) {
      if (!(filePath in expectedMap)) {
        discrepancies.push(`Unexpected archive entry found: ${filePath}`);
      }
    }

    return {
      matched: discrepancies.length === 0,
      computedDigests,
      discrepancies,
    };
  } catch (err: any) {
    discrepancies.push(`Extraction failure via native tool: ${err?.message || String(err)}`);
    return {
      matched: false,
      computedDigests: {},
      discrepancies,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
