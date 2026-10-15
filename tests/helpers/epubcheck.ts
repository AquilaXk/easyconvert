import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';

/**
 * The W3C EPUBCheck validator as an independent oracle for EPUB output. It validates against the EPUB 3.3 rules
 * (packages, content documents, navigation, accessibility metadata) and shares nothing with the writer.
 */

const EPUBCHECK_TIMEOUT_MS = 180_000;

export interface EpubcheckMessage {
  ID: string;
  severity: string;
  message: string;
  locations: { path: string; line: number; column: number }[];
}

export interface EpubcheckReport {
  fatals: number;
  errors: number;
  warnings: number;
  messages: EpubcheckMessage[];
}

/** Validates an EPUB and returns the counts and messages EPUBCheck reports. */
export function runEpubcheck(epub: Buffer): EpubcheckReport {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epubcheck-'));
  try {
    const file = path.join(dir, 'book.epub');
    const report = path.join(dir, 'report.json');
    fs.writeFileSync(file, epub);
    try {
      execFileSync(requireOracleTool('epubcheck'), [file, '--json', report, '--quiet'], { stdio: 'ignore', timeout: EPUBCHECK_TIMEOUT_MS });
    } catch (err) {
      // EPUBCheck exits non-zero when it finds errors; its report is still written.
      if (!fs.existsSync(report)) throw err;
    }
    const parsed = JSON.parse(fs.readFileSync(report, 'utf-8')) as { messages: EpubcheckMessage[]; checker: { nFatal: number; nError: number; nWarning: number } };
    return { fatals: parsed.checker.nFatal, errors: parsed.checker.nError, warnings: parsed.checker.nWarning, messages: parsed.messages };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
