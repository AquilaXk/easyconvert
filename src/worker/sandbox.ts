import {
  executeSandboxedBinary,
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  SandboxedExecutionOptions,
  SandboxedExecutionResult,
  SandboxedProcessError,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
  SandboxEnvironment,
} from '../lib/security/process-sandbox';

export {
  executeSandboxedBinary,
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  SandboxedProcessError,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
};
export type { SandboxedExecutionOptions, SandboxedExecutionResult, SandboxEnvironment };

/**
 * Worker-specific security sandbox orchestrator.
 * Enforces process-level containment, sanitized credentials, and timeout boundaries for native CLI execution.
 */
export async function runInWorkerSandbox(
  binaryPath: string,
  args: string[],
  options: SandboxedExecutionOptions = {}
): Promise<SandboxedExecutionResult> {
  const envInfo = detectSandboxEnvironment();
  return executeSandboxedBinary(binaryPath, args, {
    ...options,
    networkIsolated: options.networkIsolated ?? true,
    cwd: options.cwd,
  });
}
