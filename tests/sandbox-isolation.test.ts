import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { executeCommandSandboxed, resetUnshareCapabilityProbe } from '../src/lib/security/process-sandbox';
import { SandboxUnavailableError } from '../src/lib/types';
import node_os from 'node:os';

vi.mock('node:os', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:os')>();
  return {
    ...mod,
    platform: vi.fn(() => 'linux') // Force linux to test unshare branch
  };
});

describe('Sandbox enforcement', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetUnshareCapabilityProbe();
    vi.stubGlobal('require', { resolve: vi.fn() }); // mock if needed
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('throws SandboxUnavailableError when strict isolation is required but unshare is missing', async () => {
    process.env.STRICT_SANDBOX = 'true';
    
    // We mock child_process.spawnSync in process-sandbox to make getUnshareCapability() fail
    vi.mock('node:child_process', async (importOriginal) => {
      const mod = await importOriginal<typeof import('node:child_process')>();
      return {
        ...mod,
        spawnSync: vi.fn(() => ({ status: 1 })) // unshare capability fails
      };
    });

    // Actually, instead of mocking child_process, we can just run it in mac (os.platform = linux, but spawnSync unshare will fail)
    // Wait, let's just assert executeCommandSandboxed throws SandboxUnavailableError.
    await expect(executeCommandSandboxed('ls', ['-la'], { networkIsolated: true, strictIsolation: true }))
      .rejects.toThrow(SandboxUnavailableError);
  });
});
