import { ConversionFailedError } from '../../types';
import { decodeWindows1252 } from './windows-1252';

/**
 * Text of a Palm Markup Language (PML) e-book, from the eReader PML reference: a backslash starts a command,
 * `\\` is a literal backslash, `\aNNN` and `\UXXXX` are characters by code, `\p` ends a page, and the other
 * commands switch formatting or carry an argument in quotes (`\T="10%"`). Text between `\v` markers is
 * invisible (comments) and is not part of the book. A command outside the reference fails with a typed error
 * instead of leaking its letters into the text.
 */

/** Longest PML file read: the text is decoded in memory. */
export const PML_MAX_BYTES = 64 * 1024 * 1024;

const BACKSLASH = '\\';
const DECIMAL_CODE_DIGITS = 3;
const UNICODE_CODE_DIGITS = 4;
const HEX_RADIX = 16;
const DECIMAL_RADIX = 10;
const PARAGRAPH_BREAK = '\n\n';

/** Commands that only switch formatting or position and carry nothing to read: italic, underline, bold, size, centring, indent. */
const FORMATTING_COMMANDS: ReadonlySet<string> = new Set(['c', 'r', 'i', 'u', 'o', 'b', 'B', 'l', 'k', 's', 'n', 't', '-']);
/** Commands followed by a quoted argument that is not text (indent width, rule, image, link target, footnote id, chapter title for the index). */
const ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(['T', 'w', 'm', 'q', 'F', 'C']);
/** Superscript, subscript and sidebar link markers: `\Sp`, `\Sb` and `\Sd="id"`. */
const SCRIPT_COMMANDS: ReadonlySet<string> = new Set(['p', 'b', 'd']);
const CHAPTER_LEVEL_PATTERN = /^[0-4]$/;

function badCommand(command: string, offset: number): ConversionFailedError {
  return new ConversionFailedError(`The PML book has the command \\${command} at character ${offset}, which the PML reference does not define.`);
}

/** Skips an optional quoted argument (`="..."`) starting at `from`; returns the index after it. */
function skipArgument(pml: string, from: number, command: string): number {
  if (pml[from] !== '=' || pml[from + 1] !== '"') return from;
  const close = pml.indexOf('"', from + 2);
  if (close === -1) throw new ConversionFailedError(`The PML command \\${command} has an argument that is never closed.`);
  return close + 1;
}

/** The text of a PML document held as a string. */
export function pmlToText(pml: string): string {
  const out: string[] = [];
  let invisible = false;
  let i = 0;
  while (i < pml.length) {
    const ch = pml[i];
    if (ch !== BACKSLASH) {
      if (!invisible) out.push(ch);
      i += 1;
      continue;
    }
    const command = pml[i + 1];
    if (command === undefined) throw new ConversionFailedError('The PML book ends in the middle of a command.');
    const start = i;
    i += 2;
    if (command === BACKSLASH) {
      if (!invisible) out.push(BACKSLASH);
    } else if (command === 'a' || command === 'U') {
      const digits = command === 'a' ? DECIMAL_CODE_DIGITS : UNICODE_CODE_DIGITS;
      const radix = command === 'a' ? DECIMAL_RADIX : HEX_RADIX;
      const code = pml.slice(i, i + digits);
      if (code.length !== digits || !(radix === DECIMAL_RADIX ? /^[0-9]+$/ : /^[0-9a-fA-F]+$/).test(code)) throw badCommand(command, start);
      if (!invisible) out.push(String.fromCharCode(Number.parseInt(code, radix)));
      i += digits;
    } else if (command === 'p') {
      if (!invisible) out.push(PARAGRAPH_BREAK);
    } else if (command === 'v') {
      invisible = !invisible;
    } else if (command === 'x') {
      if (!invisible) out.push(PARAGRAPH_BREAK);
    } else if (command === 'X') {
      if (!CHAPTER_LEVEL_PATTERN.test(pml[i] ?? '')) throw badCommand(command, start);
      i += 1;
      if (!invisible) out.push(PARAGRAPH_BREAK);
    } else if (command === 'S') {
      const kind = pml[i];
      if (kind === undefined || !SCRIPT_COMMANDS.has(kind)) throw badCommand(command, start);
      i = skipArgument(pml, i + 1, `S${kind}`);
    } else if (command === 'F') {
      if (pml[i] !== 'n') throw badCommand(command, start);
      i = skipArgument(pml, i + 1, 'Fn');
    } else if (command === 'C') {
      if (!CHAPTER_LEVEL_PATTERN.test(pml[i] ?? '')) throw badCommand(command, start);
      i = skipArgument(pml, i + 1, `C${pml[i]}`);
    } else if (ARGUMENT_COMMANDS.has(command)) {
      i = skipArgument(pml, i, command);
    } else if (!FORMATTING_COMMANDS.has(command)) {
      throw badCommand(command, start);
    }
  }
  return out
    .join('')
    .replace(/<\/?(?:footnote|sidebar)\b[^>]*>/g, PARAGRAPH_BREAK)
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(PARAGRAPH_BREAK);
}

/** The text of a PML e-book file (Windows-1252 bytes); a book without text is a typed error. */
export function readPmlText(file: Buffer): string {
  if (file.length > PML_MAX_BYTES) throw new ConversionFailedError(`The PML book is longer than the ${PML_MAX_BYTES} byte limit.`);
  const text = pmlToText(decodeWindows1252(file));
  if (text === '') throw new ConversionFailedError('The PML book holds no text.');
  return text;
}
