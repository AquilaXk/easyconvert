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

/** The code point at `pos` of latin1 text (identical to its char code), or -1 past the end. */
function codeAt(text: string, pos: number): number {
  return text.codePointAt(pos) ?? -1;
}

function isRegular(code: number): boolean {
  return !WHITESPACE_CODES.has(code) && !DELIMITER_CODES.has(code);
}

/** End of the run of regular characters that starts at `from`, at most MAX_TOKEN_CHARS long. */
function regularEnd(text: string, from: number, end: number): number {
  const limit = Math.min(end, from + MAX_TOKEN_CHARS);
  let pos = from;
  while (pos < limit && isRegular(codeAt(text, pos))) pos++;
  return pos;
}

/** Index just past the literal string that opens at `open`, honouring nesting and escapes; -1 when it does not close before `end`. */
function stringEnd(text: string, open: number, end: number): number {
  let depth = 0;
  for (let pos = open; pos < end; pos++) {
    const code = codeAt(text, pos);
    if (code === BACKSLASH) pos++;
    else if (code === OPEN_PAREN) depth++;
    else if (code === CLOSE_PAREN && --depth === 0) return pos + 1;
  }
  return -1;
}

/** Index just past the hex string that opens at `open`; -1 when it does not close before `end`. */
function hexStringEnd(text: string, open: number, end: number): number {
  for (let pos = open + 1; pos < end; pos++) {
    if (codeAt(text, pos) === GREATER_THAN) return pos + 1;
  }
  return -1;
}

/** Index of the end of the comment line that starts at `from`. */
function commentEnd(text: string, from: number, end: number): number {
  let pos = from;
  while (pos < end && codeAt(text, pos) !== LINE_FEED && codeAt(text, pos) !== CARRIAGE_RETURN) pos++;
  return pos;
}

function decodeName(raw: string): string {
  return raw.includes('#') ? raw.replace(NAME_ESCAPE, (_escape, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))) : raw;
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

const INERT: EnclosingDictionary = { status: 'inert' };
const UNDELIMITED: EnclosingDictionary = { status: 'undelimited' };

function foundIn(frame: Frame): EnclosingDictionary {
  return { status: 'found', entries: frame.entries };
}

/** The verdict of one scanning step: undefined to go on, or the result of the whole scan. */
type Verdict = EnclosingDictionary | undefined;

/**
 * One pass over a window of PDF text. In `enclosing` mode it looks for the dictionary that holds the name token
 * at `markerAt`; in `window` mode (`markerAt` is -1) it collects the entries that are top-level for the window.
 */
class DictionaryScanner {
  private readonly root = newFrame();
  private readonly stack: Frame[];
  private target: Frame | undefined;
  private pos: number;

  constructor(
    private readonly text: string,
    start: number,
    private readonly end: number,
    private readonly markerAt: number,
    private readonly windowMode: boolean
  ) {
    this.stack = windowMode ? [this.root] : [];
    this.pos = start;
  }

  scan(): EnclosingDictionary {
    while (this.pos < this.end) {
      const verdict = this.step();
      if (verdict) return verdict;
    }
    return this.windowMode ? foundIn(this.root) : this.unsettled();
  }

  private get top(): Frame | undefined {
    return this.stack.at(-1);
  }

  /** The verdict when the text ends, or a token that ends a dictionary arrives, before the target is closed. */
  private unsettled(): EnclosingDictionary {
    if (this.windowMode) return foundIn(this.root);
    return this.target === undefined ? INERT : UNDELIMITED;
  }

  /** A string, hex string or comment that does not end in the window: unknown, so no more keys are read. */
  private unterminated(): EnclosingDictionary {
    return this.windowMode ? foundIn(this.root) : UNDELIMITED;
  }

  private insideMarker(from: number, to: number): boolean {
    return this.markerAt > from && this.markerAt < to;
  }

  private step(): Verdict {
    const code = codeAt(this.text, this.pos);
    if (WHITESPACE_CODES.has(code)) {
      this.pos++;
      return undefined;
    }
    switch (code) {
      case PERCENT:
        return this.comment();
      case OPEN_PAREN:
        return this.literalString();
      case LESS_THAN:
        return this.openAngle();
      case GREATER_THAN:
        return this.closeAngle();
      case OPEN_BRACKET:
      case CLOSE_BRACKET:
        return this.bracket(code);
      case SLASH:
        return this.name();
      default:
        return isRegular(code) ? this.word() : this.skip();
    }
  }

  private skip(): Verdict {
    this.pos++;
    return undefined;
  }

  private comment(): Verdict {
    const close = commentEnd(this.text, this.pos, this.end);
    if (this.markerAt >= this.pos && this.markerAt < close) return INERT;
    this.pos = close;
    return undefined;
  }

  private literalString(): Verdict {
    const close = stringEnd(this.text, this.pos, this.end);
    if (close < 0) return this.unterminated();
    if (this.insideMarker(this.pos, close)) return INERT;
    completeValue(this.top, { kind: 'other' });
    this.pos = close;
    return undefined;
  }

  /** `<<` opens a dictionary; a lone `<` opens a hex string. */
  private openAngle(): Verdict {
    if (codeAt(this.text, this.pos + 1) === LESS_THAN) {
      this.stack.push(newFrame());
      this.pos += 2;
      return undefined;
    }
    const close = hexStringEnd(this.text, this.pos, this.end);
    if (close < 0) return this.unterminated();
    if (this.insideMarker(this.pos, close)) return INERT;
    completeValue(this.top, { kind: 'other' });
    this.pos = close;
    return undefined;
  }

  /** `>>` closes a dictionary; the target's close ends the scan. */
  private closeAngle(): Verdict {
    if (codeAt(this.text, this.pos + 1) !== GREATER_THAN) return this.skip();
    this.pos += 2;
    // In window mode the bottom frame stands for a dictionary opened before the window, which is never closed here.
    if (this.windowMode && this.stack.length === 1) return undefined;
    const closed = this.stack.pop();
    if (closed !== undefined && closed === this.target) return foundIn(closed);
    completeValue(this.top, { kind: 'other' });
    return undefined;
  }

  private bracket(code: number): Verdict {
    const top = this.top;
    if (top) {
      if (code === OPEN_BRACKET) top.arrayDepth++;
      else if (top.arrayDepth > 0 && --top.arrayDepth === 0) completeValue(top, { kind: 'other' });
    }
    this.pos++;
    return undefined;
  }

  private name(): Verdict {
    const close = regularEnd(this.text, this.pos + 1, this.end);
    if (this.pos === this.markerAt && this.top) this.target = this.top;
    readName(this.top, decodeName(this.text.slice(this.pos + 1, close)));
    this.pos = close;
    return undefined;
  }

  /** A keyword, number or reference. */
  private word(): Verdict {
    const close = regularEnd(this.text, this.pos, this.end);
    const token = this.text.slice(this.pos, close);
    if (token === 'stream' || token === 'endstream') {
      // The dictionary of an object ends where its stream starts: a position after it is stream data.
      return this.unsettled();
    }
    if (token === 'obj' || token === 'endobj') {
      this.stack.length = this.windowMode ? 1 : 0;
      this.pos = close;
    } else {
      this.pos = readScalar(this.top, token, this.text, close);
    }
    return undefined;
  }
}

/**
 * Finds the dictionary whose own key starts at `markerAt` (the `/` of a name token) and returns its top-level
 * entries. Scanning starts at `start`, which should be the beginning of the enclosing indirect object, and
 * stops at `end`. Strings, hex strings and comments are skipped, and nested dictionaries and arrays are
 * values, so a key of a nested dictionary is never read as a key of the enclosing one.
 */
export function readEnclosingDictionary(text: string, start: number, markerAt: number, end: number): EnclosingDictionary {
  return new DictionaryScanner(text, start, end, markerAt, false).scan();
}

/**
 * The top-level entries of whatever dictionary the window `[start, end)` lies in, when the start of that
 * dictionary is not in view. Keys of dictionaries that open inside the window are not entries of it, so a nested
 * decoy is never read as the size; a `>>` that closes a dictionary opened before the window is ignored. The last
 * of a repeated key wins. Strings, hex strings and comments are skipped as in `readEnclosingDictionary`.
 */
export function readWindowEntries(text: string, start: number, end: number): Map<string, DictionaryValue> {
  const found = new DictionaryScanner(text, start, end, -1, true).scan();
  return found.status === 'found' ? found.entries : new Map();
}

/** A name is the key when the frame expects one, otherwise the value of the pending key. */
function readName(frame: Frame | undefined, name: string): void {
  if (!frame || frame.arrayDepth > 0) return;
  if (frame.key === undefined) frame.key = name;
  else completeValue(frame, { kind: 'other' });
}

/** Whether `token` is an integer that may start an `N G R` reference for the frame's pending key. */
function mayStartReference(frame: Frame | undefined, token: string, text: string, close: number): boolean {
  return frame?.arrayDepth === 0 && frame.key !== undefined && WHITESPACE_CODES.has(codeAt(text, close)) && INTEGER_TOKEN.test(token);
}

/** Reads a number, an `N G R` reference or a keyword value; returns the position after what was read. */
function readScalar(frame: Frame | undefined, token: string, text: string, close: number): number {
  if (!startsNumber(codeAt(token, 0)) || !NUMBER_TOKEN.test(token)) {
    completeValue(frame, { kind: 'other' });
    return close;
  }
  if (mayStartReference(frame, token, text, close)) {
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
