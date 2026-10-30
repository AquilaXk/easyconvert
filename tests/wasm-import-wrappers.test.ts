import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * A process that converts files adds no compiled WebAssembly import wrapper by tier-up: Node.js 24 (V8 13.6) frees a cached
 * import wrapper twice when a thread tiers an import up while wasm code GC frees the same wrapper, which ended a real-world
 * job server with SIGSEGV and with a V8 fatal error (see wasm-import-wrappers.ts). V8 prints a "WasmToJS wrapper" line to its
 * compilation trace when it compiles such a wrapper, so the trace says whether the faulting path is reachable.
 */

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(__dirname, 'helpers', 'wasm-import-call-probe.mts');
const WRAPPER_COMPILED = /WasmToJS wrapper/;

async function traceOfProbe(...probeArgs: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', '--trace-wasm-compilation-times', PROBE, ...probeArgs],
    { cwd: ROOT, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return `${stdout}\n${stderr}`;
}

describe('WebAssembly import calls of a conversion process', () => {
  it('compile no wrapper for a hot import once the conversion index is loaded', async () => {
    expect(await traceOfProbe()).not.toMatch(WRAPPER_COMPILED);
  }, 150_000);

  it('compile one without it, so the trace can see the wrapper', async () => {
    expect(await traceOfProbe('without-flag')).toMatch(WRAPPER_COMPILED);
  }, 150_000);
});
