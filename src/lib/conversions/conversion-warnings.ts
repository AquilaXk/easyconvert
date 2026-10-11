import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConversionResult } from '../types';

/**
 * Warnings raised deep inside a writer (a character replaced because no font can draw it) without every function between
 * the writer and the result having to carry a list. `convertFile` opens a scope; a writer reports into the scope it runs in
 * and the lines reach `metadata.warnings` of the result. Outside a scope a report is dropped, as a library call that nobody
 * collects warnings from. A nested `convertFile` shares the scope of the outer call, which attaches the lines.
 */

/** Distinct lines kept per conversion; a document full of different unmappable characters reports the first ones. */
const MAX_WARNING_LINES = 200;

const scopes = new AsyncLocalStorage<Set<string>>();

/** Reports one warning line to the conversion that is running, once per distinct line. */
export function reportConversionWarning(line: string): void {
  const lines = scopes.getStore();
  if (lines !== undefined && lines.size < MAX_WARNING_LINES) lines.add(line);
}

/** Runs `convert` in a warning scope and adds what was reported to the warnings of its result. */
export async function withConversionWarnings(convert: () => Promise<ConversionResult>): Promise<ConversionResult> {
  if (scopes.getStore() !== undefined) return convert();
  const lines = new Set<string>();
  const result = await scopes.run(lines, convert);
  if (lines.size === 0) return result;
  const existing = Array.isArray(result.metadata?.warnings) ? (result.metadata.warnings as string[]) : [];
  return { ...result, metadata: { ...result.metadata, warnings: [...existing, ...[...lines].filter((line) => !existing.includes(line))] } };
}
