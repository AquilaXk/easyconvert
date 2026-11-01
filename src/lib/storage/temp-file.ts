import crypto from 'node:crypto';

/** Opens a new file and fails when one of that name exists. */
export const EXCLUSIVE_CREATE = 'wx';

const TEMP_NAME_RANDOM_BYTES = 6;

/**
 * A temporary path beside `finalPath` that no other writer picks: two requests that write the same part at once must
 * not write into, or remove, each other's file. `tag` says what is written there, such as a part or an assembled upload.
 */
export function uniqueTempPath(finalPath: string, tag: 'tmp' | 'comb'): string {
  return `${finalPath}.${tag}.${Date.now()}.${crypto.randomBytes(TEMP_NAME_RANDOM_BYTES).toString('hex')}`;
}
