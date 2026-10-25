import net from 'node:net';
import { posix } from 'node:path';
import { StorageInputError, StorageInvalidKeyError } from './adapter-interface';

const PROVIDER = 'sftp';

/**
 * sftp(1) reads a batch line with `fgets(cmd, sizeof(cmd))` into `char cmd[2048]`
 * (openssh-portable V_9_9_P2 sftp.c:2212 and :2310). A longer line is cut there and its tail runs as the
 * next command, so a line may hold at most 2047 bytes with the newline.
 */
const MAX_LINE_BYTES = 2046;

/** `isspace` in `makeargv` ends an argument; control characters and line separators never belong in one. */
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\u2028\u2029]/u;

/** AWS Transfer Family `CreateUser` UserName rule `[\w][\w@.-]{2,99}`, with the 3 character minimum dropped. */
const USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,99}$/;

/** RFC 1123 section 2.1 labels, at most 63 characters, joined by dots to at most 253. */
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const MAX_HOSTNAME_LENGTH = 253;

export type SftpVerb = 'get' | 'put' | 'rm' | 'ls -l';

/**
 * `-b -` reads the batch from standard input and makes the client stop at the first failed command and
 * exit 1 (`batchmode` is passed as `err_abort` to `parse_dispatch_command` at sftp.c:2344, a non-zero result
 * ends the loop at sftp.c:2345 and `exit(err == 0 ? 0 : 1)` is sftp.c:2699; `-b` itself is sftp.c:2521-2531).
 * Without it a failed `put`, `rm`, `get` or `ls` is only printed and the exit status stays 0.
 */
export const SFTP_BATCH_ARGS = ['-b', '-'] as const;

/** Exit status of sftp.c:2699 when a command of the batch failed. A connection or authentication failure is 255 (`fatal`). */
export const SFTP_COMMAND_FAILED_EXIT = 1;

/** `fatal()` exits 255: no connection, a host key refused (sshconnect.c) or no authentication (sshconnect2.c:479, :542). */
export const SFTP_CONNECTION_FAILED_EXIT = 255;

/** The most a call keeps of the child's standard output and of its standard error; the child is stopped past it. */
export const SFTP_MAX_OUTPUT_BYTES = 64 * 1024;

/** The most of the client's standard error that goes into an error message. */
export const SFTP_MAX_ERROR_TEXT = 512;

export const SFTP_CHILD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

function hasForbiddenCharacter(value: string): boolean {
  return CONTROL_OR_LINE_SEPARATOR.test(value) || !value.isWellFormed();
}

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

function stripLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) start++;
  return s.slice(start);
}

/**
 * Quotes one argument for the sftp batch syntax. `makeargv` (sftp.c:1196) reads a double quoted argument
 * to the closing quote, unescapes `\"` (sftp.c:1246-1250), keeps `\\` for the glob step that follows to
 * undo (sftp.c:1264-1268), and escapes `? [ *` inside quotes itself (sftp.c:1325-1332). Escaping `\` and
 * `"` is therefore the whole rule. The caller has already refused control characters, which would end the line.
 */
function quoteSftpArg(arg: string): string {
  return `"${arg.replace(/[\\"]/g, '\\$&')}"`;
}

/**
 * One batch line: a fixed verb followed by quoted arguments. The verb is never caller data, so a leading
 * `!` (local shell), `-` (ignore errors) or `@` (silence echo), which `parse_args` reads at sftp.c:1358-1369
 * and sftp.c:1391, cannot appear in command position.
 */
export function sftpCommandLine(verb: SftpVerb, ...args: string[]): string {
  for (const arg of args) {
    if (hasForbiddenCharacter(arg)) {
      throw new StorageInvalidKeyError('An SFTP path cannot hold a control character, a line break or a NUL byte', PROVIDER);
    }
  }
  const line = `${verb} ${args.map(quoteSftpArg).join(' ')}`;
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
    throw new StorageInvalidKeyError(`An SFTP path is too long for one sftp command line (${MAX_LINE_BYTES} bytes)`, PROVIDER);
  }
  return line;
}

/** The client's own wording when a path is missing: `File "<p>" not found.` (sftp.c:664, :753) and `No such file or directory` from the server. */
const NOT_FOUND_MESSAGE = /\bnot found\b|No such file/;

/** Classifies the standard error of a command that already failed with exit 1. It is not read for any other exit. */
export function isSftpNotFound(stderr: string): boolean {
  return NOT_FOUND_MESSAGE.test(stderr);
}

export function truncateSftpErrorText(stderr: string): string {
  const text = stderr.trim();
  return text.length <= SFTP_MAX_ERROR_TEXT ? text : `${text.slice(0, SFTP_MAX_ERROR_TEXT)}...`;
}

/**
 * `ls_file` (sftp-common.c:217) writes `"%s %3s %-*s %-*s %8llu %s %s"`: mode, link count (always `?` for a remote
 * file, sftp-common.c:230), user, group, size, `%b %e %H:%M` or `%b %e  %Y`, name. The pattern is anchored to the whole line.
 */
const LS_LONG_LINE = /^[-dlcbps][-rwxsStTl]{9}\+?\s+(?:\?|\d+)\s+\S+\s+\S+\s+(\d+)\s+[A-Za-z]{3}\s+\d{1,2}\s+(?:\d{2}:\d{2}|\d{4})\s+\S/;

/**
 * The size from the output of one `ls -l`. With `-b` the client first echoes the command it runs (`sftp> ls -l "<path>"`,
 * sftp.c:1573), and that line holds caller data, so only the lines after it are read. Undefined when no line is a listing.
 */
export function parseSftpListingSize(stdout: string): number | undefined {
  const lines = stdout.split('\n');
  const echo = lines.findIndex((line) => line.startsWith('sftp> ls -l '));
  if (echo === -1) return undefined;
  const match = lines.slice(echo + 1).map((line) => LS_LONG_LINE.exec(line)).find((m) => m !== null);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

export function sftpBatch(...lines: string[]): string {
  return `${lines.join('\n')}\nquit\n`;
}

/** The directory every key lives under, normalised, or "/" for a server root. Relative paths stay relative to the login directory. */
export function normalizeBasePath(basePath: string | undefined): string {
  if (!basePath) return '/';
  if (hasForbiddenCharacter(basePath)) {
    throw new StorageInputError('The SFTP base path cannot hold a control character, a line break or a NUL byte', PROVIDER);
  }
  const stripped = stripTrailingSlashes(basePath);
  if (stripped === '') return '/';
  const root = posix.normalize(stripped);
  if (root === '..' || root.startsWith('../')) {
    throw new StorageInputError('The SFTP base path cannot climb out of the login directory', PROVIDER);
  }
  return root;
}

function isInside(root: string, candidate: string): boolean {
  if (root === '/') return candidate.startsWith('/') && candidate !== '/';
  if (root === '.') return candidate !== '.' && candidate !== '..' && !candidate.startsWith('../') && !candidate.startsWith('/');
  return candidate.startsWith(`${root}/`);
}

/**
 * Joins a key to the base path with POSIX rules and requires the result to stay below the base, so `..`
 * segments cannot leave it. A relative result gets a `./` prefix: a path that starts with `-` would
 * otherwise be read as an option by the getopt call of `ls`, `get` and `put` (sftp.c:407, :490).
 */
export function resolveRemotePath(root: string, remotePath: string): string {
  if (hasForbiddenCharacter(remotePath)) {
    throw new StorageInvalidKeyError('An SFTP path cannot hold a control character, a line break or a NUL byte', PROVIDER);
  }
  const key = posix.normalize(stripLeadingSlashes(remotePath));
  const joined = posix.normalize(`${root}/${key}`);
  if (key === '.' || key === '..' || key.startsWith('../') || !isInside(root, joined)) {
    throw new StorageInvalidKeyError('The SFTP path is empty or leaves the base path', PROVIDER);
  }
  return joined.startsWith('/') ? joined : `./${joined}`;
}

function isHostname(host: string): boolean {
  return host.length <= MAX_HOSTNAME_LENGTH && host.split('.').every((label) => HOST_LABEL.test(label));
}

/**
 * The `user@host` operand for sftp, which the caller puts after `--` (sftp.c:2655 does the same for ssh,
 * and sftp's own getopt loop at sftp.c:2470 stops at `--`). The host is a hostname or an IP literal and the
 * user a plain name, so neither can start with `-`, and the host holds no `:` or `/` that
 * `parse_user_host_path` would read as the start of a path (misc.c:838). An IPv6 literal is bracketed, the form
 * `hpdelim2` and `cleanhostname` read (misc.c:747, :796).
 */
export function sftpDestination(host: string, username: string): string {
  if (!USERNAME.test(username)) {
    throw new StorageInputError('The SFTP user name has a character or a length the sftp client does not accept', PROVIDER);
  }
  if (net.isIPv6(host)) {
    if (host.includes('%')) throw new StorageInputError('The SFTP host cannot carry an IPv6 zone', PROVIDER);
    return `${username}@[${host}]`;
  }
  if (!net.isIPv4(host) && !isHostname(host)) {
    throw new StorageInputError('The SFTP host must be a host name or an IP address', PROVIDER);
  }
  return `${username}@${host}`;
}

export function assertSftpPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StorageInputError('The SFTP port must be a whole number from 1 to 65535', PROVIDER);
  }
  return port;
}

/** What the child gets: no secret of the server process, and a HOME that is the call's own temporary directory. */
export function sftpChildEnv(homeDir: string): NodeJS.ProcessEnv {
  return { PATH: SFTP_CHILD_PATH, HOME: homeDir, LANG: 'C.UTF-8' } as unknown as NodeJS.ProcessEnv;
}

/** Key types `peek_type_nid` in sshkey.c reads at the start of a known hosts line; the certificate and `sk-` forms are not pinned. */
const PINNABLE_KEY_TYPES = new Set(['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_HOST_KEY_BASE64 = 8192;
const ASCII_LINE = /^[\t\x20-\x7e]+$/;

/** The key type inside the base64 blob is a length-prefixed string at its start (`sshkey_fromb`), which `sshkey_read` requires to match the type on the line (sshkey.c:1314-1383). */
function blobKeyType(base64: string): string | undefined {
  const blob = Buffer.from(base64, 'base64');
  if (blob.length < 4) return undefined;
  const length = blob.readUInt32BE(0);
  return length > 0 && length <= blob.length - 4 ? blob.subarray(4, 4 + length).toString('latin1') : undefined;
}

/**
 * A credential's pinned host key, as a `known_hosts` line (`host type base64 [comment]`, the format `hostkeys_foreach_file`
 * reads at hostfile.c:760-860) or a bare public key (`type base64 [comment]`), becomes the one line written to the
 * call's own known hosts file. The host field is replaced by `*`: the file holds this one key and the call connects
 * to one host, so the address and port forms (`[host]:2222`, an IP, a hash) never have to match. A marker such as
 * `@cert-authority` and a fingerprint, which `ssh` cannot pin by itself, are refused.
 */
export function sftpKnownHostsLine(hostKey: string): string {
  const invalid = (reason: string) => new StorageInputError(`The SFTP host key ${reason}`, PROVIDER);
  if (typeof hostKey !== 'string' || !ASCII_LINE.test(hostKey.trim())) {
    throw invalid('must be one line of printable ASCII: a known_hosts line or a public key');
  }
  const tokens = hostKey.trim().split(/\s+/);
  const typeIndex = tokens.findIndex((token) => PINNABLE_KEY_TYPES.has(token));
  if (typeIndex < 0 || typeIndex > 1 || tokens.length <= typeIndex + 1 || (typeIndex === 1 && tokens[0].startsWith('@'))) {
    throw invalid('must be a known_hosts line or public key of type ssh-ed25519, ecdsa-sha2-nistp256/384/521 or ssh-rsa');
  }
  const type = tokens[typeIndex];
  const base64 = tokens[typeIndex + 1];
  if (!BASE64.test(base64) || base64.length > MAX_HOST_KEY_BASE64 || blobKeyType(base64) !== type) {
    throw invalid('holds key data that is not a valid base64 key of the stated type');
  }
  return `* ${type} ${base64}\n`;
}
