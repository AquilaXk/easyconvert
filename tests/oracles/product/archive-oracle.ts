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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_NAME = /^[A-Z][a-z]{2}$/;

function splitListing(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * Parses one `tar -tv` line whose entry name is already known. The size is the integer column
 * right before the modification date (`YYYY-MM-DD` in GNU tar, a month name in bsdtar).
 */
function parseVerboseTarLine(line: string, name: string): TarEntryInfo {
  if (!line.endsWith(name)) {
    throw new Error(`tar verbose line does not end with entry name "${name}": ${line}`);
  }
  const columns = line.slice(0, line.length - name.length).trim().split(/\s+/);
  const dateIndex = columns.findIndex((col, i) => i > 0 && (ISO_DATE.test(col) || MONTH_NAME.test(col)));
  const sizeColumn = dateIndex > 0 ? columns[dateIndex - 1] : '';
  if (!/^\d+$/.test(sizeColumn)) {
    throw new Error(`Cannot locate the size column in tar verbose line: ${line}`);
  }
  return { path: name, size: Number(sizeColumn), mode: columns[0] };
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
    const run = (flags: string) =>
      execFileSync(tarPath, [flags, tempFile], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    // `-t` lists one exact name per line; `-tv` adds mode and size in the same order. Names are
    // taken from the plain listing so spaces in names never shift the verbose columns.
    const names = splitListing(run('-tf'));
    const output = run('-tvf');
    const verboseLines = splitListing(output);
    if (verboseLines.length !== names.length) {
      throw new Error(`tar listed ${names.length} names but ${verboseLines.length} verbose entries`);
    }

    const entries: TarEntryInfo[] = names.map((name, i) => parseVerboseTarLine(verboseLines[i], name));

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
