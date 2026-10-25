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
