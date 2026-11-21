import { redactText } from '../security/redact';
import { getFormatByExtension } from '../registry';
import { CLIENT_ERROR_KINDS, MAX_MESSAGE_CHARS, MAX_NAME_CHARS, MAX_PATH_CHARS, MAX_STACK_CHARS, MAX_STACK_FRAMES, type ClientErrorKind } from './report';

/**
 * What the server keeps of a crash report. The browser is not trusted: every field is read again here, a field that is not on the
 * list is dropped, and the text that remains is cut of what names a file, a person or a request (entry 384 of docs/policy-decisions.md).
 * The line has no address of the sender and no raw user agent, so it names no one.
 */

export type BrowserFamily = 'chrome' | 'edge' | 'firefox' | 'safari' | 'opera' | 'other';

export interface ClientErrorLine {
  kind: ClientErrorKind;
  name: string;
  message: string;
  frames: string[];
  digest?: string;
  path: string;
  release?: string;
  browser: BrowserFamily;
}

const NAME = new RegExp(`^[A-Za-z][A-Za-z0-9_$]{0,${MAX_NAME_CHARS - 1}}$`);
const DIGEST = /^[A-Za-z0-9]{1,32}$/;
const RELEASE = /^[0-9a-f]{7,40}$/;
const FALLBACK_NAME = 'Error';

/** The text of a message or a stack that is read: a longer text is cut first, so the scans below run over a bounded length. */
const MAX_READ_CHARS = 2000;
const MAX_PATH_SEGMENTS = 8;
const MAX_SEGMENT_CHARS = 48;
const MAX_FUNCTION_CHARS = 80;
const MAX_SCRIPT_PATH_CHARS = 150;
const MIN_TOKEN_CHARS = 20;
const MIN_NUMBER_DIGITS = 9;
const MAX_QUOTED_CHARS = 200;

const UNKNOWN_FUNCTION = '?';
const OTHER_SCRIPT = '[other]';

/** A word of a path that no page of the site has: a long number or a hex id, or anything but lower case letters, digits and `-`. */
const PAGE_SEGMENT = new RegExp(`^[a-z0-9-]{1,${MAX_SEGMENT_CHARS}}$`);
const ID_SEGMENT = /\d{6,}|^[0-9a-f-]{16,}$/;
const OPAQUE_SEGMENT = ':x';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The path of the page: no query string, no fragment, at most eight words, and a word that could be an id or a name is `:x`. */
function pagePathOf(path: string): string | null {
  const bare = path.slice(0, MAX_PATH_CHARS).split(/[?#]/, 1)[0];
  if (!bare.startsWith('/') || bare.startsWith('//')) return null;
  const segments = bare
    .slice(1)
    .split('/')
    .filter((segment) => segment !== '')
    .slice(0, MAX_PATH_SEGMENTS)
    .map((segment) => (PAGE_SEGMENT.test(segment) && !ID_SEGMENT.test(segment) ? segment : OPAQUE_SEGMENT));
  return `/${segments.join('/')}`;
}

const LINK = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)\]]*|\b(?:blob|data):[^\s"'`<>)\]]*/gi;
const EMAIL = /[^\s@"'`<>()]+@[^\s@"'`<>()]+\.[A-Za-z]{2,}/g;
const QUOTED = new RegExp(`(["'\`])((?:(?!\\1)[^\\n]){1,${MAX_QUOTED_CHARS}}?)\\1`, 'g');
const NEEDS_MASK_IN_QUOTES = /[\s./\\]/;
const FILE_NAME = /[^\s"'`()<>,;:=\\/]+\.([A-Za-z0-9]{1,8})(?![A-Za-z0-9_$(])/g;
const OPAQUE_TOKEN = new RegExp(`[A-Za-z0-9_-]{${MIN_TOKEN_CHARS},}`, 'g');
const LONG_NUMBER = new RegExp(`\\d{${MIN_NUMBER_DIGITS},}`, 'g');
const CONTROL_RUNS = /[\p{Cc}\s]+/gu;

/**
 * A message or a function name cut of what could name a person or a file: credentials (the shared redaction), links, addresses, a word
 * that ends in the extension of a format the site converts, a quoted text that holds a space, a dot or a slash, a long token that holds
 * a digit, and a long number. What it cannot know is a file name of another kind or a name in plain words, so the text is also cut short.
 */
function scrubbed(text: string, maxChars: number): string {
  return redactText(text.slice(0, MAX_READ_CHARS))
    .replace(LINK, '[url]')
    .replace(EMAIL, '[email]')
    .replace(QUOTED, (whole, quote: string, inner: string) => (NEEDS_MASK_IN_QUOTES.test(inner) ? `${quote}[text]${quote}` : whole))
    .replace(FILE_NAME, (whole, extension: string) => (getFormatByExtension(extension) ? '[file]' : whole))
    .replace(OPAQUE_TOKEN, (token) => (/\d/.test(token) ? '[token]' : token))
    .replace(LONG_NUMBER, '[n]')
    .replace(CONTROL_RUNS, ' ')
    .trim()
    .slice(0, maxChars);
}

/** `    at fn (location:line:column)` of Chrome, and `fn@location:line:column` of Firefox and Safari. */
const CHROME_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
const GECKO_FRAME = /^(.*?)@(.+?):(\d+):(\d+)\s*$/;
const FUNCTION_NAME = new RegExp(`^[\\w$.<>\\[\\] ]{1,${MAX_FUNCTION_CHARS}}$`);
const OWN_SCRIPT = new RegExp(`^/_next/static/[\\w@./\\[\\]()%-]{1,${MAX_SCRIPT_PATH_CHARS}}$`);

/** The path of a script of this site, as the build writes it; any other script (an extension, a payment script, a blob) is `[other]`. */
function scriptOf(location: string): string {
  try {
    const { pathname } = new URL(location, 'https://site.invalid');
    return OWN_SCRIPT.test(pathname) ? pathname : OTHER_SCRIPT;
  } catch {
    return OTHER_SCRIPT;
  }
}

function frameOf(line: string): string | null {
  const match = CHROME_FRAME.exec(line) ?? GECKO_FRAME.exec(line);
  if (!match) return null;
  const [, name, location, row, column] = match;
  const functionName = name && FUNCTION_NAME.test(name) ? name : UNKNOWN_FUNCTION;
  return `${functionName} ${scriptOf(location)}:${row}:${column}`;
}

/** The first frames of a stack, each as the function name and the position in a script of this site. The message line is left out. */
function framesOf(stack: unknown): string[] {
  if (typeof stack !== 'string') return [];
  const frames: string[] = [];
  for (const line of stack.slice(0, MAX_STACK_CHARS).split('\n')) {
    const frame = frameOf(line);
    if (frame) frames.push(frame);
    if (frames.length === MAX_STACK_FRAMES) break;
  }
  return frames;
}

/** The family of a browser by its user agent; the string itself is never kept. */
export function browserFamilyOf(userAgent: string | null): BrowserFamily {
  const agent = userAgent ?? '';
  if (/\bEdg(?:e|A|iOS)?\//.test(agent)) return 'edge';
  if (/\b(?:OPR|Opera)\//.test(agent)) return 'opera';
  if (/\b(?:Firefox|FxiOS)\//.test(agent)) return 'firefox';
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(agent)) return 'chrome';
  if (/\bSafari\//.test(agent)) return 'safari';
  return 'other';
}

/** The line to log for a report, or null when the report is not one. */
export function sanitiseClientError(input: unknown, userAgent: string | null): ClientErrorLine | null {
  if (!isRecord(input)) return null;
  const { kind, name, message, stack, digest, path, release } = input;
  if (typeof kind !== 'string' || !(CLIENT_ERROR_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof message !== 'string' || typeof path !== 'string') return null;
  const pagePath = pagePathOf(path);
  if (pagePath === null) return null;

  const line: ClientErrorLine = {
    kind: kind as ClientErrorKind,
    name: typeof name === 'string' && NAME.test(name) ? name : FALLBACK_NAME,
    message: scrubbed(message, MAX_MESSAGE_CHARS),
    frames: framesOf(stack),
    path: pagePath,
    browser: browserFamilyOf(userAgent),
  };
  if (typeof digest === 'string' && DIGEST.test(digest)) line.digest = digest;
  if (typeof release === 'string' && RELEASE.test(release)) line.release = release;
  return line;
}
