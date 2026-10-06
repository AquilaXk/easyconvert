/**
 * Shared secret redaction for every output surface: logs, error messages, job responses,
 * webhook payloads and dead-letter entries. One key rule and one URL rule, so a surface cannot
 * mask less than another. Every scan is a single forward pass bounded by the input length.
 */

export const REDACTION_MASK = '***';

/** Deepest nesting `redactSecrets` walks; job graphs and payloads are far shallower. */
export const MAX_REDACTION_DEPTH = 32;
/** Most values `redactSecrets` visits in one call. */
export const MAX_REDACTION_NODES = 100_000;
/** Longest chain of nested errors `scrubError` follows. */
export const MAX_ERROR_CAUSE_DEPTH = 8;
/** Most errors one `scrubError` call edits, counting causes, aggregated errors and property errors. */
const MAX_SCRUBBED_ERRORS = 32;
/** Most own enumerable properties of one error `scrubError` masks. */
const MAX_ERROR_PROPERTIES = 32;
/** Longest key token the free-text scanner considers a key; longer runs are prose. */
const MAX_TEXT_KEY_LENGTH = 64;
/** Most backslashes the scanner accepts in front of an escaped quote (JSON nested in JSON). */
const MAX_QUOTE_ESCAPES = 8;

/** Key names whose values are credentials, normalised: lower case, no `_`, `-`, `.` or spaces. */
export const SECRET_KEY_NAMES: ReadonlySet<string> = new Set([
  'secretaccesskey',
  'accesskeysecret',
  'sessiontoken',
  'securitytoken',
  'xamzsecuritytoken',
  'password',
  'passwd',
  'passphrase',
  'pass',
  'pwd',
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
  'auth',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'signature',
  'xamzsignature',
  'sig',
  'credential',
  'credentials',
  'creds',
  'webhooksecret',
  // Request headers carry credentials, so a headers map is masked whole.
  'headers',
  // The sealed blob of a job secret is not readable, but it is also not for clients.
  'sealed',
]);

/** A normalised key ending in one of these is a credential: `db_password`, `x-goog-api-key`, `myToken`. */
const SECRET_KEY_SUFFIXES: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secretkey',
  'secretaccesskey',
  'token',
  'apikey',
  'accesskey',
  'privatekey',
  'accountkey',
  'sharedkey',
  'authorization',
  'signature',
  'credential',
  'credentials',
  'cookie',
  'headers',
  'connectionstring',
  'serviceaccountkeyjson',
  // Plural nouns: `apiKeys`, `secrets`. A bare "tokens" is not here, since `maxTokens` is a limit.
  'passwords',
  'passphrases',
  'secrets',
  'apikeys',
  'accesskeys',
  'privatekeys',
  'accesstokens',
  'refreshtokens',
  'authtokens',
  'sessiontokens',
  'bearertokens',
];

/** A key containing one of these words is a credential wherever the word sits: `AWS_SECRET_ACCESS_KEY`. */
const SECRET_KEY_WORDS: ReadonlySet<string> = new Set(['password', 'passwd', 'passphrase', 'secret']);

/** Names that match the rules above but hold no credential. */
const HARMLESS_KEY_NAMES: ReadonlySet<string> = new Set(['haswebhooksecret']);

const TRAILING_DIGITS = /\d+$/;

export class RedactionLimitError extends Error {
  constructor(reason: string) {
    super(`Cannot redact value: ${reason}`);
    this.name = 'RedactionLimitError';
  }
}

function normalizeKeyName(key: string): string {
  return key.toLowerCase().replaceAll(/[-_.\s]/g, '');
}

function keyWords(key: string): string[] {
  return key
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
}

/** True for a credential's name; a trailing number (`password2`, `apiKey_3`) does not change that. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKeyName(key);
  if (HARMLESS_KEY_NAMES.has(normalized)) {
    return false;
  }
  const stem = normalized.replace(TRAILING_DIGITS, '');
  if (
    SECRET_KEY_NAMES.has(normalized) ||
    SECRET_KEY_NAMES.has(stem) ||
    SECRET_KEY_SUFFIXES.some((suffix) => stem.endsWith(suffix))
  ) {
    return true;
  }
  return keyWords(key).some((word) => SECRET_KEY_WORDS.has(word.replace(TRAILING_DIGITS, '')));
}

// `:\/\/` is how a URL looks inside a JSON string written by an encoder that escapes slashes.
const URL_SCHEME_START = /\b[a-z][a-z0-9+.-]{1,31}:(?:\\?\/){2}/gi;
// A URL percent-encoded into another URL or a log field: it cannot be split reliably, so the rest of the token is masked.
const ENCODED_URL = /\b[a-z][a-z0-9+.-]{1,31}%3A%2F%2F[^\s"'<>`]*/gi;
const URL_WHOLE = /^([a-z][a-z0-9+.-]{1,31}:(?:\\?\/){2})([\s\S]*)$/i;
const URL_TEXT_STOP: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n', '<', '>', '`', '"', "'"]);
const AUTHORITY_STOP: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n', '<', '>', '/', '?', '#']);
const QUOTE_CHARS: ReadonlySet<string> = new Set(['"', "'", '`']);
/** Punctuation that ends a sentence rather than a URL. */
const URL_TRAILING_PUNCTUATION: ReadonlySet<string> = new Set(['.', ',', ';', ':', '!', ')', ']', '}', '\\']);
const BEARER_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Only a key token is matched here; the separator and the value are read by hand and only for
// secret keys, so a long run of blanks or a long value is never re-scanned from every key inside it.
const KEY_TOKEN = new RegExp(
  String.raw`(?<![A-Za-z0-9_.-])(\\{0,${MAX_QUOTE_ESCAPES}}["']?)([A-Za-z][A-Za-z0-9_.-]{0,${MAX_TEXT_KEY_LENGTH - 1}})\1`,
  'g'
);
const BLANKS: ReadonlySet<string> = new Set([' ', '\t']);
const WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n']);
/** Longest text, in characters, for which bracket groups are matched; longer text masks to the line end. */
const MAX_BRACKET_INDEX_TEXT = 4 * 1024 * 1024;

/**
 * Masks the parts of a URL that carry credentials. `rest` is everything after `scheme://`.
 * Userinfo ends at the LAST `@` of the authority, because a password may contain `@`.
 */
function maskUrlRest(scheme: string, rest: string): string {
  let authorityEnd = 0;
  while (authorityEnd < rest.length && !AUTHORITY_STOP.has(rest[authorityEnd])) {
    authorityEnd++;
  }
  const authority = rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  const host = at >= 0 ? `${REDACTION_MASK}@${authority.slice(at + 1)}` : authority;
  const tail = rest.slice(authorityEnd);
  const hash = tail.indexOf('#');
  const beforeHash = hash >= 0 ? tail.slice(0, hash) : tail;
  const hasFragment = hash >= 0 && hash < tail.length - 1;
  const question = beforeHash.indexOf('?');
  const path = question >= 0 ? beforeHash.slice(0, question) : beforeHash;
  const hasQuery = question >= 0 && question < beforeHash.length - 1;
  return `${scheme}${host}${path}${hasQuery ? `?${REDACTION_MASK}` : ''}${hasFragment ? `#${REDACTION_MASK}` : ''}`;
}

/**
 * Masks userinfo, query and fragment of one URL, keeping scheme, host, port and path. A value that
 * is not an absolute URL is masked whole, since it cannot be told apart from a credential.
 */
export function redactUrl(url: string): string {
  const parts = URL_WHOLE.exec(url.trim());
  return parts ? maskUrlRest(parts[1], parts[2]) : REDACTION_MASK;
}

/** End (exclusive) of the URL token whose authority starts at `start`. */
function urlTokenEnd(text: string, start: number): number {
  let cursor = start;
  while (cursor < text.length && !AUTHORITY_STOP.has(text[cursor])) {
    cursor++;
  }
  const authority = text.slice(start, cursor);
  const at = authority.lastIndexOf('@');
  // Without userinfo a quote ends the URL; after it, the host part ends at the first quote.
  let firstQuote = -1;
  for (let i = at + 1; i < authority.length && firstQuote < 0; i++) {
    if (QUOTE_CHARS.has(authority[i])) {
      firstQuote = i;
    }
  }
  if (firstQuote >= 0) {
    return start + firstQuote;
  }
  while (cursor < text.length && !URL_TEXT_STOP.has(text[cursor])) {
    cursor++;
  }
  return cursor;
}

function redactUrlsInText(text: string): string {
  const scheme = new RegExp(URL_SCHEME_START.source, URL_SCHEME_START.flags);
  let out = '';
  let cursor = 0;
  let match = scheme.exec(text);
  while (match) {
    const restStart = match.index + match[0].length;
    let end = urlTokenEnd(text, restStart);
    while (end > restStart && URL_TRAILING_PUNCTUATION.has(text[end - 1])) {
      end--;
    }
    out += text.slice(cursor, match.index) + maskUrlRest(match[0], text.slice(restStart, end));
    cursor = end;
    scheme.lastIndex = Math.max(end, restStart);
    match = scheme.exec(text);
  }
  return out + text.slice(cursor);
}

/** End of the quoted value that starts at `start`, as [valueEnd, opener, closer], or null. */
function quotedValue(text: string, start: number): { end: number; opener: string; closer: string } | null {
  let quoteAt = start;
  while (quoteAt < text.length && quoteAt - start <= MAX_QUOTE_ESCAPES && text[quoteAt] === '\\') {
    quoteAt++;
  }
  const quote = text[quoteAt];
  if (quote !== '"' && quote !== "'") {
    return null;
  }
  const opener = text.slice(start, quoteAt + 1);
  if (quoteAt > start) {
    // Escaped quotes (JSON inside a JSON string): the value ends at the next identical escape.
    const close = text.indexOf(opener, quoteAt + 1);
    return close < 0 ? null : { end: close + opener.length, opener, closer: opener };
  }
  for (let cursor = quoteAt + 1; cursor < text.length; cursor++) {
    if (text[cursor] === '\\') {
      cursor++;
    } else if (text[cursor] === quote) {
      return { end: cursor + 1, opener, closer: quote };
    }
  }
  return null;
}

/** End of the line that holds `start`: the next CR or LF. Scans only as far as that line is long. */
function lineEnd(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
    end++;
  }
  return end;
}

/**
 * Where each `{` or `[` of a text closes, found in one pass for the whole text so that any number of
 * groups costs one scan. Brackets inside double-quoted strings do not count. Unclosed groups stay -1.
 */
class BracketGroups {
  private ends: Int32Array | null = null;

  constructor(private readonly text: string) {}

  /** End (exclusive) of the group that opens at `start`, or the end of its line when it never closes. */
  endOf(start: number): number {
    if (this.text.length <= MAX_BRACKET_INDEX_TEXT) {
      this.ends ??= BracketGroups.index(this.text);
      if (this.ends[start] > 0) {
        return this.ends[start];
      }
    }
    return lineEnd(this.text, start);
  }

  private static index(text: string): Int32Array {
    const ends = new Int32Array(text.length).fill(-1);
    const open: number[] = [];
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') {
        i++;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString && (ch === '{' || ch === '[')) {
        open.push(i);
      } else if (!inString && (ch === '}' || ch === ']') && open.length > 0) {
        ends[open.pop() as number] = i + 1;
      }
    }
    return ends;
  }
}

/** The replacement for a secret value that starts at `start`, and where the value ends. */
function maskedPairValue(text: string, start: number, groups: BracketGroups): { masked: string; end: number } | null {
  const quoted = quotedValue(text, start);
  if (quoted) {
    return { masked: `${quoted.opener}${REDACTION_MASK}${quoted.closer}`, end: quoted.end };
  }
  const first = text[start];
  if (first === '{' || first === '[') {
    return { masked: REDACTION_MASK, end: groups.endOf(start) };
  }
  // An unquoted value may hold spaces, quotes, commas and brackets: it ends with the line.
  const end = lineEnd(text, start);
  return end > start ? { masked: REDACTION_MASK, end } : null;
}

/** Masks the value of every `key=value`, `key: value` and `"key":"value"` pair whose key is a secret. */
function redactKeyValuePairs(text: string): string {
  const keys = new RegExp(KEY_TOKEN.source, KEY_TOKEN.flags);
  const groups = new BracketGroups(text);
  let out = '';
  let cursor = 0;
  let match = keys.exec(text);
  while (match) {
    let separator = match.index + match[0].length;
    while (separator < text.length && BLANKS.has(text[separator])) {
      separator++;
    }
    if ((text[separator] === ':' || text[separator] === '=') && isSecretKey(match[2])) {
      let valueStart = separator + 1;
      while (valueStart < text.length && WHITESPACE.has(text[valueStart])) {
        valueStart++;
      }
      const value = maskedPairValue(text, valueStart, groups);
      if (value) {
        out += text.slice(cursor, valueStart) + value.masked;
        cursor = value.end;
        keys.lastIndex = cursor;
      }
    }
    match = keys.exec(text);
  }
  return out + text.slice(cursor);
}

/** Masks credentials in free text such as error messages and log rows. */
export function redactText(text: string): string {
  const withoutUrlSecrets = redactUrlsInText(text).replaceAll(ENCODED_URL, (match) => {
    const schemeEnd = match.search(/%2F%2F/i) + '%2F%2F'.length;
    return `${match.slice(0, schemeEnd)}${REDACTION_MASK}`;
  });
  const withoutBearer = withoutUrlSecrets.replaceAll(BEARER_TOKEN, `$1 ${REDACTION_MASK}`);
  return redactKeyValuePairs(withoutBearer);
}

/**
 * Keys that hold a link the service itself minted for the job owner, such as a presigned result
 * URL. Its recipient is the owner, so the query string is the point of the link and stays as it is.
 */
const OWNER_DELIVERED_URL_KEYS: ReadonlySet<string> = new Set(['downloadurl']);

interface WalkState {
  nodes: number;
  ancestors: Set<object>;
  /** True: a limit masks the value that hit it. False: a limit throws RedactionLimitError. */
  lenient: boolean;
}

function isPlainContainer(value: object): boolean {
  return !(value instanceof Date) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer);
}

function limitHit(state: WalkState, reason: string): string {
  if (state.lenient) {
    return REDACTION_MASK;
  }
  throw new RedactionLimitError(reason);
}

/** A header as a `[name, value]` pair whose name is a credential: the value is masked by the name. */
function isSecretHeaderPair(value: unknown[]): boolean {
  return value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string' && isSecretKey(value[0]);
}

/** Map keys under which an object's own keys are ids chosen by the user (`graph.nodes.token`), not field names. */
const ID_MAP_KEYS: ReadonlySet<string> = new Set(['nodes', 'tasks']);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Error);
}

function walk(value: unknown, depth: number, state: WalkState, keysAreIds = false): unknown {
  state.nodes++;
  if (state.nodes > MAX_REDACTION_NODES) {
    return limitHit(state, `more than ${MAX_REDACTION_NODES} values`);
  }
  if (typeof value === 'string') {
    return redactText(value);
  }
  if (typeof value !== 'object' || value === null || !isPlainContainer(value)) {
    return value;
  }
  if (depth >= MAX_REDACTION_DEPTH) {
    return limitHit(state, `nesting deeper than ${MAX_REDACTION_DEPTH} levels`);
  }
  if (state.ancestors.has(value)) {
    return limitHit(state, 'circular reference');
  }
  state.ancestors.add(value);
  try {
    if (value instanceof Error) {
      return { name: value.name, message: redactText(value.message) };
    }
    if (Array.isArray(value)) {
      if (isSecretHeaderPair(value)) {
        return [value[0], REDACTION_MASK];
      }
      return value.map((item) => walk(item, depth + 1, state));
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && OWNER_DELIVERED_URL_KEYS.has(normalizeKeyName(key))) {
        out[key] = item;
        continue;
      }
      // Absent values and flags disclose nothing, so a mask would only hide that they are absent or false.
      const discloses = item !== undefined && item !== null && typeof item !== 'boolean';
      if (!keysAreIds && isSecretKey(key) && discloses) {
        out[key] = REDACTION_MASK;
      } else {
        out[key] = walk(item, depth + 1, state, !keysAreIds && ID_MAP_KEYS.has(key) && isPlainRecord(item));
      }
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
 * Throws RedactionLimitError beyond the depth, size or cycle limits; code that answers a request
 * after work has started must use `redactForOutput`.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value, 0, { nodes: 0, ancestors: new Set(), lenient: false }) as T;
}

/**
 * Like `redactSecrets`, but never throws: a value beyond a limit is replaced by the mask, so an
 * oversized field is omitted and marked as redacted instead of failing the response.
 */
export function redactForOutput<T>(value: T): T {
  return walk(value, 0, { nodes: 0, ancestors: new Set(), lenient: true }) as T;
}

function scrubOwnProperties(error: Error, queue: { error: Error; depth: number }[], depth: number): void {
  const record = error as unknown as Record<string, unknown>;
  for (const key of Object.keys(error).slice(0, MAX_ERROR_PROPERTIES)) {
    const item = record[key];
    try {
      if (item instanceof Error) {
        queue.push({ error: item, depth: depth + 1 });
      } else if (typeof item === 'string') {
        record[key] = redactText(item);
      } else if (typeof item === 'object' && item !== null) {
        record[key] = redactForOutput(item);
      }
    } catch {
      // A read-only property cannot be edited; callers also mask the text they copy out of it.
    }
  }
}

/**
 * Masks an error in place, so that every later reader of the same error (a log line, an event
 * listener, a rethrow) sees the masked text: its message and stack, its `cause` chain, the errors
 * of an AggregateError, and its own enumerable properties such as an HTTP client's request and
 * response. Bounded by MAX_ERROR_CAUSE_DEPTH, MAX_SCRUBBED_ERRORS and MAX_ERROR_PROPERTIES.
 * Values that are not errors are returned unchanged.
 */
export function scrubError<T>(error: T): T {
  const queue: { error: Error; depth: number }[] = error instanceof Error ? [{ error, depth: 0 }] : [];
  const seen = new Set<Error>();
  for (let next = queue.shift(); next && seen.size < MAX_SCRUBBED_ERRORS; next = queue.shift()) {
    if (seen.has(next.error)) {
      continue;
    }
    seen.add(next.error);
    const current = next.error;
    try {
      current.message = redactText(current.message);
      if (current.stack) {
        current.stack = redactText(current.stack);
      }
    } catch {
      // A frozen error cannot be edited; callers also mask the text they copy out of it.
    }
    if (next.depth + 1 < MAX_ERROR_CAUSE_DEPTH) {
      if (current.cause instanceof Error) {
        queue.push({ error: current.cause, depth: next.depth + 1 });
      }
      const aggregated = (current as { errors?: unknown }).errors;
      if (Array.isArray(aggregated)) {
        for (const item of aggregated.slice(0, MAX_SCRUBBED_ERRORS)) {
          if (item instanceof Error) {
            queue.push({ error: item, depth: next.depth + 1 });
          }
        }
      }
    }
    scrubOwnProperties(current, queue, next.depth);
  }
  return error;
}
