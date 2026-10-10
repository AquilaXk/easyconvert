import { SecretSealError, sealJobSecret, unsealJobSecret } from '../security/job-secret-seal';
import type { ConversionJobData } from '../types';

/**
 * The open password of a protected input travels through the queue sealed, never as plaintext.
 *
 * `options.password` is replaced by `options.sealedPassword`, an AES-256-GCM blob bound to the id of the job (see
 * job-secret-seal), before the job record is written; the worker opens it in memory at the point of use. The queue
 * therefore never persists the password, and a blob copied into another job fails authentication instead of opening.
 * The per-input `passwords` of a merge node are sealed the same way into `options.sealedPasswords`. The passwords a
 * PDF is protected with (`protect.userPassword` and `protect.ownerPassword`, or the same two keys directly in the
 * options of a pdf.protect node) are sealed into one blob, `protect.sealedPasswords` or `options.sealedProtectPasswords`.
 * An empty password is not a secret and stays as it is.
 */

const SEALED_PASSWORD_KEY = 'sealedPassword';
const SEALED_PASSWORDS_KEY = 'sealedPasswords';
const SEALED_PROTECT_KEY = 'sealedProtectPasswords';
const PROTECT_PASSWORD_KEYS = ['userPassword', 'ownerPassword'] as const;

type OptionsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OptionsRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSecretPassword(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

/** `holder` with its protect passwords (`userPassword`, `ownerPassword`) moved into one sealed blob under `sealedKey`. */
function sealProtectPasswords(holder: OptionsRecord, sealedKey: string, jobId: string): OptionsRecord {
  if (!PROTECT_PASSWORD_KEYS.some((key) => hasSecretPassword(holder[key]))) return holder;
  const secrets: OptionsRecord = {};
  const rest: OptionsRecord = { ...holder };
  for (const key of PROTECT_PASSWORD_KEYS) {
    if (key in rest) secrets[key] = rest[key];
    delete rest[key];
  }
  return { ...rest, [sealedKey]: sealJobSecret(JSON.stringify(secrets), jobId) };
}

function openProtectPasswords(holder: OptionsRecord, sealedKey: string, jobId: string): OptionsRecord {
  const sealed = holder[sealedKey];
  if (typeof sealed !== 'string') return holder;
  const secrets: unknown = JSON.parse(unsealJobSecret(sealed, jobId));
  if (!isRecord(secrets) || PROTECT_PASSWORD_KEYS.some((key) => key in secrets && typeof secrets[key] !== 'string')) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed protect passwords are malformed.');
  }
  const { [sealedKey]: _sealed, ...rest } = holder;
  return { ...rest, ...secrets };
}

/** `options` with plaintext passwords replaced by sealed blobs bound to `jobId`. */
export function sealPasswordOption<T>(options: T, jobId: string): T {
  if (!isRecord(options)) return options;
  let sealed: OptionsRecord = options;
  if (hasSecretPassword(options.password)) {
    const { password, ...rest } = sealed;
    sealed = { ...rest, [SEALED_PASSWORD_KEY]: sealJobSecret(password as string, jobId) };
  }
  if (Array.isArray(options.passwords) && options.passwords.some(hasSecretPassword)) {
    const { passwords, ...rest } = sealed;
    sealed = { ...rest, [SEALED_PASSWORDS_KEY]: sealJobSecret(JSON.stringify(passwords), jobId) };
  }
  if (isRecord(options.protect)) {
    const protect = sealProtectPasswords(options.protect, SEALED_PASSWORDS_KEY, jobId);
    if (protect !== options.protect) sealed = { ...sealed, protect };
  }
  sealed = sealProtectPasswords(sealed, SEALED_PROTECT_KEY, jobId);
  return sealed as T;
}

/**
 * `options` with its sealed passwords opened into `password` and `passwords`. Options that carry none are returned
 * as they are, including a plaintext password from a job queued before sealing existed.
 *
 * @throws SecretSealError when a blob is not sealed for `jobId` under a configured key.
 */
export function openPasswordOption<T>(options: T, jobId: string): T {
  if (!isRecord(options)) return options;
  let opened: OptionsRecord = options;
  if (typeof options[SEALED_PASSWORD_KEY] === 'string') {
    const { [SEALED_PASSWORD_KEY]: sealed, ...rest } = opened;
    opened = { ...rest, password: unsealJobSecret(sealed as string, jobId) };
  }
  if (typeof opened[SEALED_PASSWORDS_KEY] === 'string') {
    const { [SEALED_PASSWORDS_KEY]: sealed, ...rest } = opened;
    opened = { ...rest, passwords: parsePasswordList(unsealJobSecret(sealed as string, jobId)) };
  }
  if (isRecord(opened.protect)) {
    opened = { ...opened, protect: openProtectPasswords(opened.protect, SEALED_PASSWORDS_KEY, jobId) };
  }
  return openProtectPasswords(opened, SEALED_PROTECT_KEY, jobId) as T;
}

function parsePasswordList(json: string): Array<string | null> {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.some((entry) => entry !== null && typeof entry !== 'string')) {
    throw new SecretSealError('MALFORMED_BLOB', '[JobSecretSeal] Sealed password list is malformed.');
  }
  return parsed as Array<string | null>;
}

/** The job data with the password of its options (and of each task's options) sealed for `jobId`. */
export function sealJobDataSecrets(data: ConversionJobData, jobId: string): ConversionJobData {
  const tasks = data.tasks?.map((task) => ({ ...task, options: sealPasswordOption(task.options, jobId) }));
  return {
    ...data,
    options: sealPasswordOption(data.options, jobId),
    ...(tasks === undefined ? {} : { tasks }),
  };
}
