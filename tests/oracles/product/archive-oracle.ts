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
const CLOCK_TIME = /^\d{1,2}:\d{2}(?::\d{2})?$/;
const MONTH_NAME = /^[A-Z][a-z]{2}$/;
const DAY_OF_MONTH = /^\d{1,2}$/;
const YEAR = /^\d{4}$/;
const SIZE = /^\d+$/;
const SYMLINK_MODE = 'l';
const HARDLINK_MODE = 'h';
const SYMLINK_SEPARATOR = ' -> ';
const HARDLINK_SEPARATOR = ' link to ';

function splitListing(output: string): string[] {
  return output.split('\n').filter((line) => line.length > 0);
}

/**
 * Finds the size in the metadata columns before the entry name, anchored on the date columns
 * that end them: GNU tar prints `owner/group size YYYY-MM-DD HH:MM`, bsdtar prints
 * `links owner group size Mon DD HH:MM|YYYY`. Anchoring from the right keeps an owner or group
 * that looks like a month name from being taken for the date.
 */
function sizeFromColumns(columns: string[]): string | undefined {
  const n = columns.length;
  if (ISO_DATE.test(columns[n - 2] ?? '') && CLOCK_TIME.test(columns[n - 1] ?? '')) {
    return columns[n - 3];
  }
  const timeOrYear = columns[n - 1] ?? '';
  const isBsdDate =
    MONTH_NAME.test(columns[n - 3] ?? '') &&
    DAY_OF_MONTH.test(columns[n - 2] ?? '') &&
    (CLOCK_TIME.test(timeOrYear) || YEAR.test(timeOrYear));
  if (isBsdDate) {
    return columns[n - 4];
  }
  return undefined;
}

/** Splits `<metadata> <name><separator><target>` at the first name occurrence whose metadata parses. */
function linkMetadataColumns(line: string, name: string, separator: string): string[] | undefined {
  const marker = ` ${name}${separator}`;
  for (let at = line.indexOf(marker); at >= 0; at = line.indexOf(marker, at + 1)) {
    const columns = line.slice(0, at).trim().split(/\s+/);
    if (sizeFromColumns(columns) !== undefined) return columns;
  }
  return undefined;
}

function metadataColumns(line: string, name: string, mode: string): string[] {
  if (mode.startsWith(SYMLINK_MODE) || mode.startsWith(HARDLINK_MODE)) {
    const separator = mode.startsWith(SYMLINK_MODE) ? SYMLINK_SEPARATOR : HARDLINK_SEPARATOR;
    const columns = linkMetadataColumns(line, name, separator);
    if (!columns) {
      throw new Error(`Cannot locate the size column in tar verbose line for link "${name}": ${line}`);
    }
    return columns;
  }
  if (!line.endsWith(` ${name}`)) {
    throw new Error(`tar verbose line does not end with entry name "${name}": ${line}`);
  }
  return line.slice(0, line.length - name.length).trim().split(/\s+/);
}

/**
 * Parses one `tar -tv` line whose entry name is already known from `tar -t`. Link entries carry
 * their target after the name (` -> target` for symlinks, ` link to target` for hard links).
 * Exported for the parser's own regression tests.
 */
export function parseVerboseTarLine(line: string, name: string): TarEntryInfo {
  const mode = line.trimStart().split(/\s+/)[0] ?? '';
  const sizeColumn = sizeFromColumns(metadataColumns(line, name, mode));
  if (sizeColumn === undefined || !SIZE.test(sizeColumn)) {
    throw new Error(`Cannot locate the size column in tar verbose line: ${line}`);
  }
  return { path: name, size: Number(sizeColumn), mode };
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
