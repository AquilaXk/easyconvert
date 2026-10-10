/**
 * Job server for the corpus runner, run as a child process (`node --import tsx bench/realworld/child.ts`). It takes one
 * job at a time over IPC, converts through the dispatcher the worker runs, checks the output and answers with the facts the
 * parent turns into a verdict. A crash of this process or a job past its deadline is handled by the parent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../../src/lib/conversions/dispatch';
import { ConversionFailedError } from '../../src/lib/types';
import { outputProblem } from './output-check';
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

/** Tool paths the parent resolved; an empty value means the validator for that kind is not run. */
const PDFINFO = process.env.REALWORLD_PDFINFO ?? '';
const IDENTIFY = process.env.REALWORLD_IDENTIFY ?? '';

function errorFacts(error: unknown): ErrorFacts {
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null;
  return { typed: error instanceof ConversionFailedError || status !== null, status };
}

async function runJob(job: JobRequest): Promise<JobReply> {
  const started = performance.now();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'realworld-'));
  try {
    const result = await dispatchConversion(fs.readFileSync(job.path), job.format, job.target, {}, job.name);
    const ms = performance.now() - started;
    const problem = await outputProblem(result.buffer, job.target, workDir, { mimeType: result.mimeType, pdfinfo: PDFINFO, identify: IDENTIFY });
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
