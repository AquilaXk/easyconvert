import os from 'node:os';
import path from 'node:path';
import { CONFIG_SCHEMA } from '../config/schema';
import { resolveLocalStorageDir } from '../storage/storage-config';
import { SANDBOX_DEFAULT_PATH } from './process-sandbox';
import { redactPaths, redactText } from './redact';

type Env = Readonly<Record<string, string | undefined>>;

const TOOL_KINDS: ReadonlySet<string> = new Set(['executable', 'absoluteExecutable']);

function configuredValue(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/** The directories of the configured tools and the configured directories (`TESSDATA_PREFIX`, `JAVA_HOME`). */
function configuredDirectories(env: Env): string[] {
  return CONFIG_SCHEMA.flatMap((spec) => {
    const value = configuredValue(env, spec.name);
    if (value === undefined) return [];
    if (TOOL_KINDS.has(spec.kind.type)) return [path.dirname(value)];
    return spec.kind.type === 'path' ? [value] : [];
  });
}

/** The install prefix of a `bin` directory (`/usr/local` for `/usr/local/bin`), where an engine also keeps its libraries. */
function installPrefix(directory: string): string[] {
  return path.basename(directory) === 'bin' ? [path.dirname(directory)] : [];
}

/**
 * The directories whose paths the servers write into an error: the temporary directory, the working directory, the storage
 * directory, the directories the sandbox runs engines from (`PATH`) and the configured tools, and their install prefixes.
 */
export function serverPathRoots(env: Env = process.env): string[] {
  const engineDirectories = [...(configuredValue(env, 'PATH') ?? SANDBOX_DEFAULT_PATH).split(':'), ...configuredDirectories(env)];
  const candidates = [os.tmpdir(), process.cwd(), resolveLocalStorageDir(env), ...engineDirectories, ...engineDirectories.flatMap(installPrefix)];
  const roots = candidates.filter((candidate) => path.isAbsolute(candidate)).map((candidate) => path.resolve(candidate));
  return [...new Set(roots)].filter((root) => root !== path.sep);
}

/** The text of a failure as a job, a graph node and their events store it: credentials and the server's paths masked. */
export function maskedFailureReason(error: unknown): string {
  return redactText(redactPaths(error instanceof Error ? error.message : String(error), serverPathRoots()));
}
