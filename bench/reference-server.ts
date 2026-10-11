import { type ChildProcessByStdio, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { TOOL_TIMEOUT_MS } from './config';
import { ToolRunError } from './errors';

/**
 * Client of `bench/reference-server.py`: one Python process for the length of a family run, which keeps the
 * reference libraries (DuckDB, Apache Arrow, fontTools, openpyxl) imported, so that a timed reference call measures the
 * conversion and not the interpreter start. Requests and answers are one JSON object per line.
 */

const SERVER_SCRIPT = path.join(__dirname, 'reference-server.py');
const SHUTDOWN_GRACE_MS = 5_000;

interface Pending {
  op: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Answer {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class ReferenceServer {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private exited = false;
  private readonly exit: Promise<void>;

  private constructor(private readonly child: ChildProcessByStdio<Writable, Readable, null>) {
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.answer(line));
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exited = true;
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer);
          request.reject(new ToolRunError(`the reference server ended (${code ?? signal}) during ${request.op}`));
          this.pending.delete(id);
        }
        resolve();
      });
    });
    child.stdin.on('error', () => undefined);
  }

  /** Starts the server with `python`, which must import the libraries the requests need. */
  static start(python: string): ReferenceServer {
    return new ReferenceServer(spawn(python, ['-I', SERVER_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] }));
  }

  private answer(line: string): void {
    const answer = JSON.parse(line) as Answer;
    const request = this.pending.get(answer.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(answer.id);
    if (answer.ok) request.resolve(answer.result);
    else request.reject(new ToolRunError(`reference server ${request.op}: ${answer.error ?? 'failed'}`));
  }

  call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    if (this.exited) return Promise.reject(new ToolRunError(`the reference server is not running (${op})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.child.kill();
        reject(new ToolRunError(`reference server ${op} did not finish in ${TOOL_TIMEOUT_MS} ms`));
      }, TOOL_TIMEOUT_MS);
      this.pending.set(id, { op, resolve: resolve as (value: unknown) => void, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
  }

  /** Ends the server: its input closes, and a process that has not ended within the grace period is killed. */
  async close(): Promise<void> {
    if (this.exited) return;
    this.child.stdin.end();
    const killer = setTimeout(() => this.child.kill(), SHUTDOWN_GRACE_MS);
    await this.exit;
    clearTimeout(killer);
  }
}
