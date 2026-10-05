import { execFileSync, type ExecFileSyncOptionsWithBufferEncoding } from 'node:child_process';
import {
  ArchiveNotEncryptedError,
  ArchivePasswordRequiredError,
  ConversionFailedError,
  InvalidArchivePasswordError,
  UnsupportedOptionError,
} from '../types';

/**
 * Archive password delivery to 7-Zip (issue #490).
 *
 * The password never appears in argv, where any local user could read it from /proc/<pid>/cmdline.
 * It is written to the child's stdin and answers 7-Zip's console prompt. Measured on p7zip 16.02
 * and 7-Zip 21.07, 22.01 and 23.01, the prompt rules are the same on all of them but differ by mode:
 *
 * - Extracting or listing: leave `-p` out. 7-Zip then prompts and reads stdin when it is a pipe. A
 *   bare `-p` is an empty password in this mode on every version, so even the correct password
 *   fails with "Wrong password" and stdin is never read.
 * - Creating: use a bare `-p` (SEVEN_ZIP_ASK_PASSWORD_SWITCH). 7-Zip prompts for the password and a
 *   confirmation. Leaving `-p` out makes 7-Zip write an UNENCRYPTED archive without any warning.
 *
 * p7zip 16.02 reads the prompt through getpass(), which prefers the controlling terminal over a
 * piped stdin. execFileSyncWithPasswordStdin therefore starts the child in its own session, which
 * drops the controlling terminal (the async sandbox runner already does).
 */

/** Creating an archive: the bare switch that makes 7-Zip ask for the password on stdin. */
export const SEVEN_ZIP_ASK_PASSWORD_SWITCH = '-p';

/** Longest password accepted, in UTF-8 bytes. p7zip 16.02 loses long console input at 4096 bytes. */
export const MAX_ARCHIVE_PASSWORD_BYTES = 1024;

/** ZIP AES-256 rejects longer passwords with E_INVALIDARG (7-Zip kPasswordSizeMax). */
export const MAX_ZIP_PASSWORD_BYTES = 99;

/** A line break or NUL would end the password early or answer a later prompt. */
const PASSWORD_FORBIDDEN_CHARACTERS = /[\r\n\0]/;

/** unrar exit status RARX_BADPWD: a RAR5 archive's password check value rejected the password. */
export const UNRAR_BAD_PASSWORD_EXIT_STATUS = 11;

/**
 * What a failed decryption reports on stderr: 7-Zip ("Wrong password", "Cannot open encrypted
 * archive. Wrong password?", "Data Error in encrypted file. Wrong password?", identical across
 * p7zip 16.02 and 7-Zip 21.07 to 23.01) and unrar ("Corrupt file or wrong password" for RAR 4,
 * "Incorrect password for <name>" and "The specified password is incorrect." for RAR5).
 */
const ARCHIVE_TOOL_PASSWORD_FAILURE =
  /wrong password|Can(?: )?not open encrypted|incorrect password|specified password is incorrect/i;

export function assertArchivePasswordSafe(password: string | undefined): void {
  if (!password) return;
  if (PASSWORD_FORBIDDEN_CHARACTERS.test(password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }
  if (Buffer.byteLength(password, 'utf-8') > MAX_ARCHIVE_PASSWORD_BYTES) {
    throw new ConversionFailedError(`Archive password exceeds the ${MAX_ARCHIVE_PASSWORD_BYTES} byte limit.`);
  }
}

/** 7-Zip encrypts ZIP entries with ASCII passwords of at most 99 bytes and fails the run otherwise. */
export function assertZipPasswordSupported(password: string | undefined): void {
  if (!password) return;
  // ASCII-only text has the same length in UTF-16 code units and in UTF-8 bytes.
  const utf8Bytes = Buffer.byteLength(password, 'utf-8');
  if (utf8Bytes !== password.length || utf8Bytes > MAX_ZIP_PASSWORD_BYTES) {
    throw new UnsupportedOptionError(
      `ZIP encryption supports ASCII passwords of at most ${MAX_ZIP_PASSWORD_BYTES} characters. Use a 7z target for other passwords.`
    );
  }
}

/**
 * Stdin that answers the password prompt of an extract or list run. A request without a password
 * answers with an empty line, not end of input: 7-Zip 21.07 and later treat end of input at the
 * prompt as a user abort ("Break signaled") and print no password error, while an empty password
 * produces the usual "Wrong password" report that the callers map to a typed error.
 */
export function sevenZipReadPasswordInput(password: string | undefined): Buffer {
  assertArchivePasswordSafe(password);
  return Buffer.from(`${password ?? ''}\n`, 'utf-8');
}

/** Stdin that answers the password prompt and its confirmation when creating an encrypted archive. */
export function sevenZipCreatePasswordInput(password: string): Buffer {
  assertArchivePasswordSafe(password);
  const answer = `${password}\n`;
  return Buffer.from(answer + answer, 'utf-8');
}

/**
 * execFileSync for a child that may read a password from `options.input`.
 *
 * The child answers its prompt only when the archive is encrypted. Otherwise it exits without
 * reading stdin, and in roughly 6% of runs Node reports the unread write as EPIPE even though the
 * child succeeded (measured on 7-Zip 23.01). An EPIPE with exit status 0 is therefore a success.
 * Any other failure, EPIPE included, is rethrown with its stderr so the caller can classify it.
 */
export function execFileSyncWithPasswordStdin(
  binary: string,
  args: readonly string[],
  options: Omit<ExecFileSyncOptionsWithBufferEncoding, 'encoding' | 'detached'> & { input: Buffer }
): Buffer {
  // Node's spawnSync honors `detached` (setsid) although its typings do not list it.
  const spawnOptions: ExecFileSyncOptionsWithBufferEncoding & { detached: boolean } = {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
    detached: true,
    encoding: 'buffer',
  };
  try {
    return execFileSync(binary, args, spawnOptions);
  } catch (err) {
    const failure = err as { code?: string; status?: number | null; stdout?: Buffer | null };
    if (failure.code === 'EPIPE' && failure.status === 0) {
      return failure.stdout ?? Buffer.alloc(0);
    }
    throw err;
  }
}

export function isArchivePasswordFailure(output: string): boolean {
  return ARCHIVE_TOOL_PASSWORD_FAILURE.test(output);
}

/** Message, stderr and stdout of a failed child, whichever shape the caller's runner throws. */
export function archiveFailureOutput(err: unknown): string {
  const failure = err as { message?: unknown; stderr?: unknown; stdout?: unknown } | null;
  return [failure?.message, failure?.stderr, failure?.stdout]
    .map((part) => (part === undefined || part === null ? '' : String(part)))
    .join('\n');
}

/** Exit status of a failed child, whichever shape the caller's runner throws. */
function archiveFailureExitStatus(err: unknown): number | null {
  const failure = err as { status?: unknown; exitCode?: unknown } | null;
  const status = failure?.status ?? failure?.exitCode;
  return typeof status === 'number' ? status : null;
}

export function isArchivePasswordError(err: unknown): err is ArchivePasswordRequiredError | InvalidArchivePasswordError {
  return err instanceof ArchivePasswordRequiredError || err instanceof InvalidArchivePasswordError;
}

/**
 * Maps a failed 7-Zip or unrar run to a typed password error: required when the request had no
 * password, invalid when it had one. Returns null when the failure is not about the password.
 * `label` names the archive in the message, for example "ZIP archive" or "multi-volume archive".
 */
export function archivePasswordError(
  err: unknown,
  request: { password: string | undefined; label: string; tool?: 'unrar' }
): ConversionFailedError | null {
  const badPasswordStatus = request.tool === 'unrar' && archiveFailureExitStatus(err) === UNRAR_BAD_PASSWORD_EXIT_STATUS;
  if (!badPasswordStatus && !isArchivePasswordFailure(archiveFailureOutput(err))) return null;
  if (!request.password) {
    const subject = request.label.charAt(0).toUpperCase() + request.label.slice(1);
    return new ArchivePasswordRequiredError(`${subject} is password protected. A password is required to extract.`);
  }
  return new InvalidArchivePasswordError(`Invalid password for encrypted ${request.label}.`);
}

/** Largest verification listing read; a bigger one cannot prove encryption and fails the creation. */
export const MAX_ENCRYPTION_LISTING_BYTES = 16 * 1024 * 1024;

/** What `7z l -slt` said about a freshly created archive, listed with an empty password. */
export interface EncryptionListingOutcome {
  /** stdout of a listing that succeeded. */
  listing?: string;
  /** Message, stderr and stdout of a listing that failed. */
  failureOutput?: string;
}

export interface EncryptionVerdict {
  /** `header`: even the file list needs the password. `entries`: every file entry is encrypted. */
  protection: 'header' | 'entries';
  encryptedEntries: number;
}

const LISTING_ENTRY_SEPARATOR = /\r?\n\r?\n/;
const LISTING_ENTRIES_START = /^-{10}\r?$/m;

/** Entries of a `-slt` listing as key/value maps; the archive's own header block is dropped. */
function parseListingEntries(listing: string): Array<Map<string, string>> {
  const start = LISTING_ENTRIES_START.exec(listing);
  if (!start) return [];
  return listing
    .slice(start.index + start[0].length)
    .split(LISTING_ENTRY_SEPARATOR)
    .map((block) => {
      const fields = new Map<string, string>();
      for (const line of block.split(/\r?\n/)) {
        const separator = line.indexOf(' = ');
        if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 3));
      }
      return fields;
    })
    .filter((fields) => fields.has('Path'));
}

/**
 * Decides from an unauthenticated `7z l -slt` whether a password-protected target really is.
 * A 7-Zip that ignores its password prompt writes a plain archive and still exits 0, so the
 * creation result alone proves nothing. 7z targets are written with a header password (-mhe=on):
 * the file list must then be unreadable, and a listing that succeeds means the names are exposed.
 * ZIP names are never encrypted, so every file entry must report `Encrypted = +` instead; folders
 * carry no data and always report `-`. Anything else, including a listing that failed for another
 * reason, is not proof of encryption and throws.
 */
export function assertListingShowsEncryption(
  format: 'zip' | '7z',
  outcome: EncryptionListingOutcome
): EncryptionVerdict {
  if (outcome.listing === undefined) {
    if (outcome.failureOutput !== undefined && isArchivePasswordFailure(outcome.failureOutput)) {
      return { protection: 'header', encryptedEntries: 0 };
    }
    throw new ConversionFailedError('Could not verify that the archive is encrypted.');
  }
  if (format === '7z') throw new ArchiveNotEncryptedError();

  const files = parseListingEntries(outcome.listing).filter((entry) => entry.get('Folder') !== '+');
  const plaintext = files.filter((entry) => entry.get('Encrypted') !== '+');
  if (plaintext.length > 0) throw new ArchiveNotEncryptedError();
  return { protection: 'entries', encryptedEntries: files.length };
}

/** Stdin for the verification listing: an empty password, so an encrypted header reports "Wrong password". */
export function sevenZipEncryptionCheckInput(): Buffer {
  return sevenZipReadPasswordInput(undefined);
}
