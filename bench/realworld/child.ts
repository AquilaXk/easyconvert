/**
 * Job server for the corpus runner, run as a child process (`node --import tsx bench/realworld/child.ts`). It takes one
 * job at a time over IPC, converts through the dispatcher the worker runs, checks the output and answers with the facts the
 * parent turns into a verdict. A crash of this process or a job past its deadline is handled by the parent.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../../src/lib/conversions/dispatch';
import { isFormatCompatibleWithMagicBytes } from '../../src/lib/registry';
import { ConversionFailedError } from '../../src/lib/types';
import type { ErrorFacts } from './verdict';

export interface JobRequest {
  id: number;
  path: string;
  name: string;
  format: string;
  target: string;
}

export type JobReply =
  | { id: number; kind: 'ok'; bytes: number; ms: number }
  | { id: number; kind: 'bad-output'; bytes: number; ms: number; reason: string }
  | { id: number; kind: 'error'; ms: number; facts: ErrorFacts; name: string; message: string };

const VALIDATOR_TIMEOUT_MS = 60_000;
const IMAGE_TARGETS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'tiff', 'tif', 'bmp', 'avif', 'heic', 'ico']);
const PACKAGE_PARTS: Readonly<Record<string, string>> = {
  docx: '[Content_Types].xml',
  xlsx: '[Content_Types].xml',
  pptx: '[Content_Types].xml',
  odt: 'mimetype',
  ods: 'mimetype',
  odp: 'mimetype',
  epub: 'mimetype',
};
/** Tool paths the parent resolved; an empty value means the validator for that kind is not run. */
const PDFINFO = process.env.REALWORLD_PDFINFO ?? '';
const IDENTIFY = process.env.REALWORLD_IDENTIFY ?? '';

function errorFacts(error: unknown): ErrorFacts {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null;
  return { typed: error instanceof ConversionFailedError || status !== null, status };
}

/** Why the output is not a readable file of the target type, or null when it is. */
async function outputProblem(buffer: Buffer, target: string, workDir: string): Promise<string | null> {
  if (buffer.length === 0) return 'empty output';
  if (!isFormatCompatibleWithMagicBytes(buffer, target)) return `output bytes do not match ${target}`;
  const part = PACKAGE_PARTS[target];
  if (part !== undefined) {
    const zip = await JSZip.loadAsync(buffer).catch(() => null);
    if (zip === null || zip.file(part) === null) return `${target} package has no ${part}`;
  }
  const file = path.join(workDir, `out.${target}`);
  fs.writeFileSync(file, buffer);
  try {
    if (target === 'pdf' && PDFINFO !== '') execFileSync(PDFINFO, [file], { stdio: 'pipe', timeout: VALIDATOR_TIMEOUT_MS });
    if (IMAGE_TARGETS.has(target) && IDENTIFY !== '') execFileSync(IDENTIFY, [file], { stdio: 'pipe', timeout: VALIDATOR_TIMEOUT_MS });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim().split('\n')[0] ?? String(error);
    return `reference reader refused the output: ${stderr}`;
  }
  return null;
}

async function runJob(job: JobRequest): Promise<JobReply> {
  const started = performance.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-'));
  try {
    const result = await dispatchConversion(fs.readFileSync(job.path), job.format, job.target, {}, job.name);
    const ms = performance.now() - started;
    const problem = await outputProblem(result.buffer, job.target, workDir);
    if (problem !== null) return { id: job.id, kind: 'bad-output', bytes: result.buffer.length, ms, reason: problem };
    return { id: job.id, kind: 'ok', bytes: result.buffer.length, ms };
  } catch (error) {
    const ms = performance.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : typeof error;
    return { id: job.id, kind: 'error', ms, facts: errorFacts(error), name, message: message.slice(0, 500) };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

process.on('message', (job: JobRequest) => {
  void runJob(job).then((reply) => process.send?.(reply));
});
process.send?.({ ready: true });
