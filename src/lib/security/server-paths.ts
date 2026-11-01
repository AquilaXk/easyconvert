import os from 'node:os';
import path from 'node:path';
import { CONFIG_SCHEMA } from '../config/schema';
import { resolveLocalStorageDir } from '../storage/storage-config';
import { SANDBOX_DEFAULT_PATH } from './process-sandbox';
import { redactFailureText, scrubError } from './redact';

type Env = Readonly<Record<string, string | undefined>>;

const TOOL_KINDS: ReadonlySet<string> = new Set(['executable', 'absoluteExecutable']);

/**
 * The top-level directories of the server images that hold the servers' and the engines' files: install prefixes (`/opt`,
 * `/usr`), configuration (`/etc`), state and runtime files (`/var`, `/run`, `/srv`), homes, libraries and programs, the
 * temporary directory, process files, the application (`/app`) and the shared storage volume (`/shared`).
 */
export const STANDARD_PATH_ROOTS: readonly string[] = Object.freeze([
  '/opt',
  '/etc',
  '/var',
  '/home',
  '/srv',
  '/root',
  '/run',
  '/lib',
  '/lib64',
  '/usr',
  '/bin',
  '/sbin',
  '/tmp',
  '/proc',
  '/app',
  '/shared',
]);

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

/** The directory `read` names, or none when it cannot be read: `process.cwd()` throws once the working directory is gone. */
function readableDirectory(read: () => string): string[] {
  try {
    return [read()];
  } catch {
    return [];
  }
}

/**
 * The directories whose paths the servers write into an error: the standard top-level directories of the images, the
 * temporary directory, the working directory, the storage directory, the directories the sandbox runs engines from
 * (`PATH`) and the configured tools, and their install prefixes.
 */
export function serverPathRoots(env: Env = process.env): string[] {
  const engineDirectories = [...(configuredValue(env, 'PATH') ?? SANDBOX_DEFAULT_PATH).split(':'), ...configuredDirectories(env)];
  const candidates = [
    ...STANDARD_PATH_ROOTS,
    os.tmpdir(),
    ...readableDirectory(() => process.cwd()),
    ...readableDirectory(() => resolveLocalStorageDir(env)),
    ...engineDirectories,
    ...engineDirectories.flatMap(installPrefix),
  ];
  const roots = candidates.filter((candidate) => path.isAbsolute(candidate)).map((candidate) => path.resolve(candidate));
  return [...new Set(roots)].filter((root) => root !== path.sep);
}

/** The roots of this process, read once when the server starts. */
export const SERVER_PATH_ROOTS: readonly string[] = Object.freeze(serverPathRoots());

/** A text with credentials and the paths under the roots of this process masked. */
export function maskServerText(text: string): string {
  return redactFailureText(text, SERVER_PATH_ROOTS);
}

/**
 * Masks a caught failure in place (its message, stack, causes and own fields) and returns its masked text, the reason a job
 * or a graph node stores. Every later reader of the error (the failed event, a webhook, a dead letter, a log line) sees the
 * same text. An error that cannot be edited still gives a masked reason.
 */
export function maskFailure(error: unknown): string {
  scrubError(error, SERVER_PATH_ROOTS);
  return maskServerText(error instanceof Error ? error.message : String(error));
}
