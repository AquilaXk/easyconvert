import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeSandboxedBinary, resolveSandboxedCommand, SandboxedProcessError } from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';
import { reading, resetMetrics } from './helpers/metrics-readings';

/** A program the sandbox does not start is counted by why: the system refused the start, or the host cannot confine it. */

const MISSING_BINARY = path.join('/nonexistent-easyconvert-dir', 'no-such-tool');
const failures = (reason: string) => reading('easyconvert_sandbox_spawn_failures_total', { reason });
const originalPlatform = process.platform;

beforeEach(() => resetMetrics());
afterEach(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }));

describe('easyconvert_sandbox_spawn_failures_total', () => {
  it('counts a program the operating system could not start as spawn_error', async () => {
    await expect(executeSandboxedBinary(MISSING_BINARY, [], { networkIsolated: false })).rejects.toBeInstanceOf(SandboxedProcessError);

    expect(await failures('spawn_error')).toBe(1);
    expect(await failures('sandbox_unavailable')).toBe(0);
  });

  it('counts a refusal to run a program unconfined as sandbox_unavailable', async () => {
    // A host that is not Linux has no network namespaces, so a strict run is refused before anything starts.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    expect(() => resolveSandboxedCommand('/bin/true', [], { networkIsolated: true, strictIsolation: true })).toThrow(SandboxUnavailableError);

    expect(await failures('sandbox_unavailable')).toBe(1);
    expect(await failures('spawn_error')).toBe(0);
  });

  it('counts nothing for a program that started and exited with an error', async () => {
    await expect(executeSandboxedBinary('/bin/sh', ['-c', 'exit 3'], { networkIsolated: false })).rejects.toBeInstanceOf(SandboxedProcessError);

    expect(await failures('spawn_error')).toBe(0);
    expect(await failures('sandbox_unavailable')).toBe(0);
  });
});
