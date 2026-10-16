/** Argument parsing and tool lookup shared by the command line runners of the corpora (run.ts, regression/run.ts). */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EXIT_PASS = 0;
export const EXIT_GATE = 1;
export const EXIT_ERROR = 2;

export class ArgumentError extends Error {}

export function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) throw new ArgumentError(`${name} needs a value`);
  args.splice(at, 2);
  return value;
}

export function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new ArgumentError(`${name} must be a positive integer`);
  return parsed;
}

/** Fixed system directories searched for tools; PATH is not trusted, so a writable directory on it cannot supply one. */
const TOOL_DIRECTORIES = ['/usr/bin', '/usr/local/bin', '/bin'] as const;

export function toolPath(name: string): string {
  const found = TOOL_DIRECTORIES.map((dir) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
  return found ?? '';
}

export function commit(): string {
  const git = toolPath('git');
  if (git === '') return process.env.GITHUB_SHA ?? 'unknown';
  try {
    return execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return process.env.GITHUB_SHA ?? 'unknown';
  }
}

