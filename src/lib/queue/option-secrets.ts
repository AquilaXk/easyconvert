import { sealJobSecret, unsealJobSecret } from '../security/job-secret-seal';
import type { ConversionJobData } from '../types';

/**
 * The open password of a protected input travels through the queue sealed, never as plaintext.
 *
 * `options.password` is replaced by `options.sealedPassword`, an AES-256-GCM blob bound to the id of the job (see
 * job-secret-seal), before the job record is written; the worker opens it in memory at the point of use. The queue
 * therefore never persists the password, and a blob copied into another job fails authentication instead of opening.
 * An empty password is not a secret and stays as it is.
 */

const SEALED_PASSWORD_KEY = 'sealedPassword';

type OptionsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OptionsRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `options` with a plaintext `password` replaced by a `sealedPassword` bound to `jobId`. */
export function sealPasswordOption<T>(options: T, jobId: string): T {
  if (!isRecord(options) || typeof options.password !== 'string' || options.password.length === 0) return options;
  const { password, ...rest } = options;
  return { ...rest, [SEALED_PASSWORD_KEY]: sealJobSecret(password, jobId) } as T;
}

/**
 * `options` with its `sealedPassword` opened into `password`. Options that carry no sealed password are returned as
 * they are, including a plaintext password from a job queued before sealing existed.
 *
 * @throws SecretSealError when the blob is not sealed for `jobId` under a configured key.
 */
export function openPasswordOption<T>(options: T, jobId: string): T {
  if (!isRecord(options) || typeof options[SEALED_PASSWORD_KEY] !== 'string') return options;
  const { [SEALED_PASSWORD_KEY]: sealed, ...rest } = options;
  return { ...rest, password: unsealJobSecret(sealed as string, jobId) } as T;
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
