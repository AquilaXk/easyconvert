/**
 * Shared secret redaction for every output surface: logs, error messages, job responses,
 * webhook payloads and dead-letter entries. One key set and one URL rule, so a surface cannot
 * mask less than another.
 */

export const REDACTION_MASK = '***';

/** Deepest nesting `redactSecrets` walks; job graphs and payloads are far shallower. */
export const MAX_REDACTION_DEPTH = 32;
/** Most values `redactSecrets` visits in one call. */
export const MAX_REDACTION_NODES = 100_000;
/** Longest key token the free-text scanner considers a key; longer runs are prose. */
const MAX_TEXT_KEY_LENGTH = 64;

/** Key names whose values are credentials, normalised: lower case, no `_`, `-` or spaces. */
export const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'secretaccesskey',
  'accesskeysecret',
  'sessiontoken',
  'securitytoken',
  'xamzsecuritytoken',
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'xapikey',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'accountkey',
  'sharedkey',
  'sastoken',
  'connectionstring',
  'serviceaccountkeyjson',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'signature',
  'xamzsignature',
  'webhooksecret',
  // Request headers carry credentials, so a headers map is masked whole.
  'headers',
  // The sealed blob of a job secret is not readable, but it is also not for clients.
  'sealed',
]);

export class RedactionLimitError extends Error {
  constructor(reason: string) {
    super(`Cannot redact value: ${reason}`);
    this.name = 'RedactionLimitError';
  }
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase().replaceAll(/[-_\s]/g, ''));
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>]+/gi;
const URL_PARTS = /^([a-z][a-z0-9+.-]{1,15}:\/\/)([^\s/?#@"'<>]*@)?([^\s?#"'<>]*)(\?[^\s#"'<>]*)?(#[^\s"'<>]*)?$/i;
/** Punctuation that ends a sentence rather than a URL. */
const URL_TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', ')', ']', '}']);
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g;
/** Longest run of blanks between a key, its separator and its value. */
const MAX_PAIR_BLANKS = 16;
// Only the key and separator are matched here; the value is read separately and only for secret keys,
// so a long unbroken value is never re-scanned from every key inside it.
const KEY_AND_SEPARATOR = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(["']?)([A-Za-z][A-Za-z0-9_-]{0,${MAX_TEXT_KEY_LENGTH - 1}})\1([ \t]{0,${MAX_PAIR_BLANKS}}[:=][ \t]{0,${MAX_PAIR_BLANKS}})`,
  'g'
);
const PAIR_VALUE =
  /"(?:[^"\\]|\\.)*"|'[^']*'|(?:Bearer|Basic|Digest)[ \t]+[^\s,;&"'}\]]+|[^\s,;&"'}\]]+|["']\S*/y;

function maskUrlParts(core: string): string | null {
  const parts = URL_PARTS.exec(core);
  if (!parts) {
    return null;
  }
  const [, scheme, userinfo, rest, query, fragment] = parts;
  return [
    scheme,
    userinfo ? `${REDACTION_MASK}@` : '',
    rest,
    query ? `?${REDACTION_MASK}` : '',
    fragment ? `#${REDACTION_MASK}` : '',
  ].join('');
}

/**
 * Masks userinfo, query and fragment of one URL, keeping scheme, host, port and path. A value that
 * is not an absolute URL is masked whole, since it cannot be told apart from a credential.
 */
export function redactUrl(url: string): string {
  return maskUrlParts(url.trim()) ?? REDACTION_MASK;
}

function redactUrlsInText(text: string): string {
  return text.replaceAll(URL_IN_TEXT, (match) => {
    let end = match.length;
    while (end > 0 && URL_TRAILING_PUNCTUATION.has(match[end - 1])) {
      end--;
    }
    return `${maskUrlParts(match.slice(0, end)) ?? match}${match.slice(end)}`;
  });
}

function maskPairValue(value: string): string {
  const quote = value[0];
  const quoted = value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
  return quoted ? `${quote}${REDACTION_MASK}${quote}` : REDACTION_MASK;
}

/** Masks the value of every `key=value`, `key: value` and `"key":"value"` pair whose key is a secret. */
function redactKeyValuePairs(text: string): string {
  const keys = new RegExp(KEY_AND_SEPARATOR.source, KEY_AND_SEPARATOR.flags);
  const values = new RegExp(PAIR_VALUE.source, PAIR_VALUE.flags);
  let out = '';
  let cursor = 0;
  let match = keys.exec(text);
  while (match) {
    const valueStart = match.index + match[0].length;
    values.lastIndex = valueStart;
    const value = isSecretKey(match[2]) ? values.exec(text)?.[0] : undefined;
    if (value === undefined) {
      match = keys.exec(text);
    } else {
      out += text.slice(cursor, valueStart) + maskPairValue(value);
      cursor = valueStart + value.length;
      keys.lastIndex = cursor;
      match = keys.exec(text);
    }
  }
  return out + text.slice(cursor);
}

/** Masks credentials in free text such as error messages and log rows. */
export function redactText(text: string): string {
  const withoutUrlSecrets = redactUrlsInText(text);
  const withoutBearer = withoutUrlSecrets.replaceAll(BEARER_TOKEN, `$1 ${REDACTION_MASK}`);
  return redactKeyValuePairs(withoutBearer);
}

/** Longest chain of `cause` errors `scrubError` follows. */
export const MAX_ERROR_CAUSE_DEPTH = 8;

/**
 * Masks the message and stack of an error, and of its `cause` chain, in place, so that every later
 * reader of the same error (a log line, an event listener, a rethrow) sees the masked text. Values
 * that are not errors are returned unchanged.
 */
export function scrubError<T>(error: T): T {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH && current instanceof Error; depth++) {
    try {
      current.message = redactText(current.message);
      if (current.stack) {
        current.stack = redactText(current.stack);
      }
    } catch {
      // A frozen error cannot be edited; callers also mask the text they copy out of it.
    }
    current = current.cause;
  }
  return error;
}

interface WalkState {
  nodes: number;
  ancestors: Set<object>;
}

function isPlainContainer(value: object): boolean {
  return !(value instanceof Date) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);
}

function walk(value: unknown, depth: number, state: WalkState): unknown {
  state.nodes++;
  if (state.nodes > MAX_REDACTION_NODES) {
    throw new RedactionLimitError(`more than ${MAX_REDACTION_NODES} values`);
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (typeof value !== 'object' || value === null || !isPlainContainer(value)) {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    throw new RedactionLimitError(`nesting deeper than ${MAX_REDACTION_DEPTH} levels`);
  }
  if (state.ancestors.has(value)) {
    throw new RedactionLimitError('circular reference');
  }
  state.ancestors.add(value);
  try {
    if (value instanceof Error) {
      return { name: value.name, message: redactText(value.message) };
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, state));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const keep = item === undefined || item === null;
      out[key] = isSecretKey(key) && !keep ? REDACTION_MASK : walk(item, depth + 1, state);
    }
    return out;
  } finally {
    state.ancestors.delete(value);
  }
}

/**
 * Returns a copy of `value` that is safe to log or send: values under secret keys are masked and
 * every string has URL userinfo and query strings, bearer tokens and secret pairs masked. Maps,
 * sets and binary values are returned as they are and must not hold credentials.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value, 0, { nodes: 0, ancestors: new Set() }) as T;
}
