/**
 * Reads the entries of the dictionary that encloses a given position of a PDF file (ISO 32000-1 7.3), without
 * a full parser: enough of the syntax to tell the top-level keys of one dictionary from the keys of the
 * dictionaries nested in it. Used to read the size of an image XObject from the dictionary that holds its
 * `/Subtype /Image`. Every loop advances through the text, and the scan stops at `end`, so the cost is
 * bounded by the window the caller passes.
 */

/** A value of a dictionary entry, reduced to what the image size check needs. */
export type DictionaryValue =
  | { kind: 'number'; value: number }
  | { kind: 'reference'; objectNumber: number }
  | { kind: 'other' };

export type EnclosingDictionary =
  /** The dictionary closed inside the window; `entries` holds its own keys, the last of a repeated key winning. */
  | { status: 'found'; entries: Map<string, DictionaryValue> }
  /** The position is not a key of any dictionary here: inside a string or comment, in stream data, or at top level. */
  | { status: 'inert' }
  /** The dictionary does not close inside the window, or a string in it does. */
  | { status: 'undelimited' };

const TAB = 9;
const LINE_FEED = 10;
const FORM_FEED = 12;
const CARRIAGE_RETURN = 13;
const SPACE = 32;
const NUL = 0;
const PERCENT = 0x25;
const OPEN_PAREN = 0x28;
const CLOSE_PAREN = 0x29;
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const SLASH = 0x2f;
const BACKSLASH = 0x5c;
/** Longest name or keyword read as one token; PDF limits names to 127 bytes. */
const MAX_TOKEN_CHARS = 512;
const NUMBER_TOKEN = /^[+-]?\d{1,10}(?:\.\d{0,10})?$/;
const INTEGER_TOKEN = /^\d{1,10}$/;
const REFERENCE_TAIL = /\s{1,16}(\d{1,5})\s{1,16}R(?![A-Za-z0-9])/y;
const NAME_ESCAPE = /#([0-9a-fA-F]{2})/g;

const WHITESPACE_CODES = new Set([NUL, TAB, LINE_FEED, FORM_FEED, CARRIAGE_RETURN, SPACE]);
const DELIMITER_CODES = new Set([
  OPEN_PAREN,
  CLOSE_PAREN,
  LESS_THAN,
  GREATER_THAN,
  OPEN_BRACKET,
  CLOSE_BRACKET,
  OPEN_BRACE,
  CLOSE_BRACE,
  SLASH,
  PERCENT,
]);

interface Frame {
  entries: Map<string, DictionaryValue>;
  /** The key waiting for its value; undefined while the next token is a key. */
  key?: string;
  /** Open `[` of the current value: tokens inside an array are values of the array, not keys. */
  arrayDepth: number;
}

function newFrame(): Frame {
  return { entries: new Map(), arrayDepth: 0 };
}

function isRegular(code: number): boolean {
  return !WHITESPACE_CODES.has(code) && !DELIMITER_CODES.has(code);
}

/** End of the run of regular characters that starts at `from`, at most MAX_TOKEN_CHARS long. */
function regularEnd(text: string, from: number, end: number): number {
  const limit = Math.min(end, from + MAX_TOKEN_CHARS);
  let pos = from;
  while (pos < limit && isRegular(text.charCodeAt(pos))) pos++;
  return pos;
}

/** Index just past the literal string that opens at `open`, honouring nesting and escapes; -1 when it does not close before `end`. */
function stringEnd(text: string, open: number, end: number): number {
  let depth = 0;
  for (let pos = open; pos < end; pos++) {
    const code = text.charCodeAt(pos);
    if (code === BACKSLASH) pos++;
    else if (code === OPEN_PAREN) depth++;
    else if (code === CLOSE_PAREN && --depth === 0) return pos + 1;
  }
  return -1;
}

/** Index just past the hex string that opens at `open`; -1 when it does not close before `end`. */
function hexStringEnd(text: string, open: number, end: number): number {
  for (let pos = open + 1; pos < end; pos++) {
    if (text.charCodeAt(pos) === GREATER_THAN) return pos + 1;
  }
  return -1;
}

/** Index of the end of the comment line that starts at `from`. */
function commentEnd(text: string, from: number, end: number): number {
  let pos = from;
  while (pos < end && text.charCodeAt(pos) !== LINE_FEED && text.charCodeAt(pos) !== CARRIAGE_RETURN) pos++;
  return pos;
}

function decodeName(raw: string): string {
  return raw.indexOf('#') === -1 ? raw : raw.replace(NAME_ESCAPE, (_escape, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** True when the character may start a number: a digit, a sign or a point. */
function startsNumber(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e;
}

/** Records the finished value of the frame's pending key (nothing inside an array, nothing without a key). */
function completeValue(frame: Frame | undefined, value: DictionaryValue): void {
  if (!frame || frame.arrayDepth > 0) return;
  if (frame.key !== undefined) frame.entries.set(frame.key, value);
  frame.key = undefined;
}

/**
 * Finds the dictionary whose own key starts at `markerAt` (the `/` of a name token) and returns its top-level
 * entries. Scanning starts at `start`, which should be the beginning of the enclosing indirect object, and
 * stops at `end`. Strings, hex strings and comments are skipped, and nested dictionaries and arrays are
 * values, so a key of a nested dictionary is never read as a key of the enclosing one.
 */
export function readEnclosingDictionary(text: string, start: number, markerAt: number, end: number): EnclosingDictionary {
  return scanDictionaries(text, start, markerAt, end, false);
}

/**
 * The top-level entries of whatever dictionary the window `[start, end)` lies in, when the start of that
 * dictionary is not in view. Keys of dictionaries that open inside the window are not entries of it, so a nested
 * decoy is never read as the size; a `>>` that closes a dictionary opened before the window is ignored. The last
 * of a repeated key wins. Strings, hex strings and comments are skipped as in `readEnclosingDictionary`.
 */
export function readWindowEntries(text: string, start: number, end: number): Map<string, DictionaryValue> {
  const found = scanDictionaries(text, start, -1, end, true);
  return found.status === 'found' ? found.entries : new Map();
}

function scanDictionaries(text: string, start: number, markerAt: number, end: number, windowMode: boolean): EnclosingDictionary {
  const root = newFrame();
  const stack: Frame[] = windowMode ? [root] : [];
  let target: Frame | undefined;
  let pos = start;
  while (pos < end) {
    const code = text.charCodeAt(pos);
    const top = stack[stack.length - 1];
    if (WHITESPACE_CODES.has(code)) {
      pos++;
    } else if (code === PERCENT) {
      const close = commentEnd(text, pos, end);
      if (markerAt >= pos && markerAt < close) return { status: 'inert' };
      pos = close;
    } else if (code === OPEN_PAREN) {
      const close = stringEnd(text, pos, end);
      if (close < 0) return windowMode ? { status: 'found', entries: root.entries } : { status: 'undelimited' };
      if (markerAt > pos && markerAt < close) return { status: 'inert' };
      completeValue(top, { kind: 'other' });
      pos = close;
    } else if (code === LESS_THAN && text.charCodeAt(pos + 1) === LESS_THAN) {
      stack.push(newFrame());
      pos += 2;
    } else if (code === LESS_THAN) {
      const close = hexStringEnd(text, pos, end);
      if (close < 0) return windowMode ? { status: 'found', entries: root.entries } : { status: 'undelimited' };
      if (markerAt > pos && markerAt < close) return { status: 'inert' };
      completeValue(top, { kind: 'other' });
      pos = close;
    } else if (code === GREATER_THAN && text.charCodeAt(pos + 1) === GREATER_THAN) {
      if (windowMode && stack.length === 1) {
        // Closes a dictionary that opened before the window.
        pos += 2;
        continue;
      }
      const closed = stack.pop();
      if (closed !== undefined && closed === target) return { status: 'found', entries: closed.entries };
      completeValue(stack[stack.length - 1], { kind: 'other' });
      pos += 2;
    } else if (code === OPEN_BRACKET && top) {
      top.arrayDepth++;
      pos++;
    } else if (code === CLOSE_BRACKET && top) {
      if (top.arrayDepth > 0 && --top.arrayDepth === 0) completeValue(top, { kind: 'other' });
      pos++;
    } else if (code === SLASH) {
      const close = regularEnd(text, pos + 1, end);
      if (pos === markerAt && top) target = top;
      readName(top, decodeName(text.slice(pos + 1, close)));
      pos = close;
    } else if (isRegular(code)) {
      const close = regularEnd(text, pos, end);
      const token = text.slice(pos, close);
      if (token === 'stream' || token === 'endstream') {
        // The dictionary of an object ends where its stream starts: a position after it is stream data.
        if (windowMode) return { status: 'found', entries: root.entries };
        return target === undefined ? { status: 'inert' } : { status: 'undelimited' };
      }
      if (token === 'obj' || token === 'endobj') {
        stack.length = windowMode ? 1 : 0;
        pos = close;
      } else {
        pos = readScalar(top, token, text, close);
      }
    } else {
      pos++;
    }
  }
  if (windowMode) return { status: 'found', entries: root.entries };
  return target === undefined ? { status: 'inert' } : { status: 'undelimited' };
}

/** A name is the key when the frame expects one, otherwise the value of the pending key. */
function readName(frame: Frame | undefined, name: string): void {
  if (!frame || frame.arrayDepth > 0) return;
  if (frame.key === undefined) frame.key = name;
  else completeValue(frame, { kind: 'other' });
}

/** Reads a number, an `N G R` reference or a keyword value; returns the position after what was read. */
function readScalar(frame: Frame | undefined, token: string, text: string, close: number): number {
  if (!startsNumber(token.charCodeAt(0)) || !NUMBER_TOKEN.test(token)) {
    completeValue(frame, { kind: 'other' });
    return close;
  }
  if (frame && frame.arrayDepth === 0 && frame.key !== undefined && WHITESPACE_CODES.has(text.charCodeAt(close)) && INTEGER_TOKEN.test(token)) {
    REFERENCE_TAIL.lastIndex = close;
    const reference = REFERENCE_TAIL.exec(text);
    if (reference) {
      completeValue(frame, { kind: 'reference', objectNumber: Number(token) });
      return close + reference[0].length;
    }
  }
  completeValue(frame, { kind: 'number', value: Number(token) });
  return close;
}
