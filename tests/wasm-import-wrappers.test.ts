import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A process that converts files keeps every WebAssembly call into a JavaScript import on V8's generic wrapper. Node.js 24
 * (V8 13.6) frees a compiled import wrapper twice when a thread tiers an import up while wasm code GC frees the same wrapper,
 * which ended a real-world job server with SIGSEGV and with a V8 fatal error (see wasm-import-wrappers.ts). The probe compares
 * the cost of an import call on a warm instance with the cost on new instances: about 0.2 when V8 tiers imports up, about 1
 * when it does not.
 */

const PROBE = path.join(__dirname, 'helpers', 'wasm-import-call-probe.ts');
/** Halfway between the two cases: tier-up measured 0.06 to 0.39 and the generic wrapper 0.57 to 1.63 on a loaded VM. */
const MIN_MEDIAN_RATIO = 0.6;

describe('WebAssembly import calls of a conversion process', () => {
  it('stay on the generic wrapper after many calls', () => {
    const output = execFileSync(process.execPath, ['--import', 'tsx', PROBE], { encoding: 'utf8', timeout: 120_000 });
    const ratios = JSON.parse(output.trim().split('\n').pop() ?? '[]') as number[];
    expect(ratios).toHaveLength(5);
    expect(ratios[2]).toBeGreaterThan(MIN_MEDIAN_RATIO);
  }, 150_000);
});
