export {
  executeSandboxedBinary,
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  SandboxedProcessError,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
} from '../lib/security/process-sandbox';

export type {
  SandboxedExecutionOptions,
  SandboxedExecutionResult,
  SandboxEnvironment,
} from '../lib/security/process-sandbox';

import {
  executeSandboxedBinary,
  SandboxedExecutionOptions,
  SandboxedExecutionResult,
} from '../lib/security/process-sandbox';

/**
 * Worker-specific security sandbox orchestrator.
 * Enforces process-level containment, sanitized credentials, and timeout boundaries for native CLI execution.
 */
export async function runInWorkerSandbox(
  binaryPath: string,
  args: string[],
  options: SandboxedExecutionOptions = {}
): Promise<SandboxedExecutionResult> {
  return executeSandboxedBinary(binaryPath, args, {
    ...options,
    networkIsolated: options.networkIsolated ?? true,
    cwd: options.cwd,
  });
}
