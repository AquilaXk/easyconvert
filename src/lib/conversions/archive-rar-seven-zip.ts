import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupDirectoryTree, extractArchiveContainedSync, type ArchiveExtractionLimits } from './archive-extraction-safety';
import { canonicalEntryPath } from './archive-entry-path';
import { matchArchiveGlob } from './archive-glob';
import { readSandboxOutput } from '../security/sandbox-output';
import type { ConversionFailedError } from '../types';

/** Longest one 7-Zip extraction of a RAR archive may run. */
const RAR_EXTRACT_TIMEOUT_MS = 30_000;

/**
 * A RAR archive extracted by 7-Zip, for an archive the in-process reader cannot serve (a compressed RAR 4.x, any RAR 5.0) on a host without
 * `unrar`: the worker image has 7-Zip, which reads both generations. The same checks as every 7-Zip extraction apply (listing vetted, sizes and
 * ratio capped, the tree verified after the run). Without a 7-Zip (`p7zBin` null) the caller's own refusal is thrown.
 */
export function extractRarWithSevenZipOr(
  refusal: ConversionFailedError,
  p7zBin: string | null,
  rarBuffer: Buffer,
  options: { password?: string; entries?: string[] },
  limits: ArchiveExtractionLimits
): { filename: string; buffer: Buffer }[] {
  if (!p7zBin) throw refusal;
  const workDir = path.join(os.tmpdir(), `easyconvert_rar7z_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const archivePath = path.join(workDir, 'archive.rar');
    fs.writeFileSync(archivePath, rarBuffer);
    const extractDir = path.join(workDir, 'out');
    fs.mkdirSync(extractDir, { recursive: true });
    const tree = extractArchiveContainedSync({
      p7zBin,
      archivePath,
      extractDir,
      cwd: workDir,
      timeoutMs: RAR_EXTRACT_TIMEOUT_MS,
      maxBuffer: limits.MAX_UNCOMPRESSED_SIZE,
      limits,
      label: 'RAR archive',
      password: options.password,
    });
    const extracted: { filename: string; buffer: Buffer }[] = [];
    for (const file of tree.files) {
      const filename = canonicalEntryPath(file.relPath);
      if (filename && matchArchiveGlob(filename, options.entries)) extracted.push({ filename, buffer: readSandboxOutput(file.absPath) });
    }
    return extracted;
  } finally {
    cleanupDirectoryTree(workDir);
  }
}
