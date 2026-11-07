import { isUtf8 } from 'node:buffer';

/**
 * The characters of a DXF drawing's text: the encoding of the file, the escapes of the file format and the codes of TEXT and
 * MTEXT strings, as ezdxf reads them (MIT, github.com/mozman/ezdxf, commit c498560bb491c357deda538360ed0c8fdb11f5a7):
 * - the encoding of a drawing before release 2007 is its `$DWGCODEPAGE` (`tools/codepage.py` `toencoding`, lines 57 to 87),
 *   UTF-8 from release 2007 (`filemanagement.py` `dxf_stream_info`, lines 175 to 186; `recover.py` `detect_encoding`, lines 692 to 724), Windows-1252 when nothing says more;
 * - `\U+XXXX` and `\M+nXXXX` become the characters they name, in every string value (`lldxf/encoding.py` lines 8, 9 and 37 to 85,
 *   applied at `recover.py` lines 871 to 877);
 * - TEXT: the caret notation, then `%%d`, `%%p`, `%%c` and `%%%`, and the toggles `%%u`, `%%o` and `%%k` ignored
 *   (`tools/text.py` `caret_decode`, lines 506 to 519, and `plain_text`, lines 279 to 306; `lldxf/const.py` `SPECIAL_CHAR_ENCODING`, lines 368 to 373);
 * - MTEXT: the commands of `MTextParser` (`tools/text.py`, lines 1244 to 1670) with the line structure of
 *   `plain_mtext` (lines 542 to 597); a column break is a space as in `fast_plain_mtext` (lines 423 to 503).
 * The text of the drawing is read with these rules and drawn in plain characters; the properties MTEXT sets (colour, font,
 * height, width, tracking, oblique, alignment, underline) are not drawn and are read only so that they leave no text behind.
 */

// ---------------------------------------------------------------------------------------------------------------
// Encoding of the file

/** `$DWGCODEPAGE` names ending in these numbers, in the order ezdxf tests them, and the encoding that reads them. */
const CODE_PAGE_ENCODINGS: ReadonlyArray<readonly [string, string]> = [
  ['874', 'windows-874'],
  ['932', 'shift_jis'],
  ['936', 'gbk'],
  ['949', 'euc-kr'],
  ['950', 'big5'],
  ['1250', 'windows-1250'],
  ['1251', 'windows-1251'],
  ['1252', 'windows-1252'],
  ['1253', 'windows-1253'],
  ['1254', 'windows-1254'],
  ['1255', 'windows-1255'],
  ['1256', 'windows-1256'],
  ['1257', 'windows-1257'],
  ['1258', 'windows-1258'],
];
const DEFAULT_ENCODING = 'windows-1252';
/** The first release whose files are always UTF-8. */
const UNICODE_RELEASE = 'AC1021';
const HEADER_SCAN_BYTES = 1 << 20;
const ACADVER_VALUE = /\$ACADVER[ \t]*\r?\n[ \t]*1[ \t]*\r?\n([^\r\n]*)/;
const DWGCODEPAGE_VALUE = /\$DWGCODEPAGE[ \t]*\r?\n[ \t]*3[ \t]*\r?\n([^\r\n]*)/;
const BYTE_ORDER_MARK = [0xef, 0xbb, 0xbf];

/** The HEADER section of the file as Latin-1 text (the names and numbers in it are ASCII), cut at its first ENDSEC. */
function headerText(bytes: Buffer): string {
  const text = bytes.subarray(0, Math.min(bytes.length, HEADER_SCAN_BYTES)).toString('latin1');
  const end = text.indexOf('ENDSEC');
  return end < 0 ? text : text.slice(0, end);
}

/** The encoding that reads a `$DWGCODEPAGE` such as `ANSI_949`; any name it does not know is Windows-1252 (ezdxf `toencoding`). */
function encodingOfCodePage(codePage: string): string {
  return CODE_PAGE_ENCODINGS.find(([suffix]) => codePage.endsWith(suffix))?.[1] ?? DEFAULT_ENCODING;
}

/** The encoding the header of a text DXF names: UTF-8 from release 2007, otherwise the code page, Windows-1252 without one. */
function declaredEncoding(bytes: Buffer): string {
  const header = headerText(bytes);
  const version = ACADVER_VALUE.exec(header)?.[1].trim() ?? 'AC1009';
  if (version >= UNICODE_RELEASE) return 'utf-8';
  const codePage = DWGCODEPAGE_VALUE.exec(header)?.[1].trim();
  return codePage === undefined ? DEFAULT_ENCODING : encodingOfCodePage(codePage);
}

/**
 * The text of a DXF file. Before release 2007 a file is in the code page its header names (ezdxf reads it so), and a byte
 * string that is valid UTF-8 and holds letters beyond ASCII is UTF-8 whatever the header says: writers that never learned
 * the rule label UTF-8 files `ANSI_1252`, and a legacy double-byte text is practically never valid UTF-8.
 */
export function decodeDxfBytes(bytes: Buffer): string {
  const bom = bytes.length >= BYTE_ORDER_MARK.length && BYTE_ORDER_MARK.every((byte, i) => bytes[i] === byte);
  if (bom || isUtf8(bytes)) return bytes.toString('utf-8');
  const encoding = declaredEncoding(bytes);
  return encoding === 'utf-8' ? bytes.toString('utf-8') : new TextDecoder(encoding).decode(bytes);
}

// ---------------------------------------------------------------------------------------------------------------
// Escapes of the file format

const DXF_UNICODE = /\\U\+([A-Fa-f0-9]{4})/g;
const DXF_MIF = /\\M\+([1-5])([A-Fa-f0-9]{4})/g;
/** The code page of the digit after `\M+` (ezdxf `MIF_CODE_PAGE`); digit 4 is Johab, which the platform's decoders do not offer. */
const MIF_ENCODINGS: Readonly<Record<string, string | undefined>> = { 1: 'shift_jis', 2: 'big5', 3: 'euc-kr', 5: 'gbk' };
const mifDecoders = new Map<string, TextDecoder>();

/** The character of one `\M+nXXXX`; a sequence its code page cannot read stays as written (ezdxf `_decode_mif`). */
function mifCharacter(written: string, digit: string, hex: string): string {
  const encoding = MIF_ENCODINGS[digit];
  if (encoding === undefined) return written;
  let decoder = mifDecoders.get(encoding);
  if (decoder === undefined) {
    decoder = new TextDecoder(encoding, { fatal: true });
    mifDecoders.set(encoding, decoder);
  }
  try {
    return decoder.decode(Buffer.from(hex, 'hex'));
  } catch {
    return written;
  }
}

/** `\U+XXXX` (four hex digits, either case) and `\M+nXXXX` replaced by their characters. */
export function decodeDxfEscapes(value: string): string {
  let text = value;
  if (text.includes('\\U+')) text = text.replace(DXF_UNICODE, (_written, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)));
  if (text.includes('\\M+')) text = text.replace(DXF_MIF, mifCharacter);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------
// Caret notation and % codes

const CARET_PAIR = /\^([^\n])/gu;
const CARET_OFFSET = 64;
const CARET_RANGE = 126;
const SPECIAL_CODE = /%%(%|[dDpPcCuUoOkK]|\d{3})/y;
const SPECIAL_CODES = /%%(%|[dDpPcCuUoOkK]|\d{3})/g;
const MIN_CODE_CHARACTER = 32;
const MAX_CODE_CHARACTER = 255;

/** `^I` is a tab, `^ ` a caret: the character that follows a caret, minus 64, modulo 126 (ezdxf `caret_decode`). */
function caretDecode(text: string): string {
  if (!text.includes('^')) return text;
  return text.replace(CARET_PAIR, (_written, character: string) => String.fromCodePoint((((character.codePointAt(0) ?? 0) - CARET_OFFSET) % CARET_RANGE + CARET_RANGE) % CARET_RANGE));
}

/**
 * The text of a `%%` code: `%%d` a degree sign, `%%p` a plus-minus sign, `%%c` a diameter sign, `%%%` a percent sign; the
 * toggles `%%u`, `%%o` and `%%k` leave nothing; `%%nnn` is the character of that decimal code (the AutoCAD text codes; ezdxf
 * has no reading of it, and a code outside 32 to 255 stays as written).
 */
function specialCharacter(written: string, token: string): string {
  switch (token.toLowerCase()) {
    case '%':
      return '%';
    case 'd':
      return '°';
    case 'p':
      return '±';
    case 'c':
      return 'Ø';
    case 'u':
    case 'o':
    case 'k':
      return '';
    default: {
      const code = Number.parseInt(token, 10);
      return code >= MIN_CODE_CHARACTER && code <= MAX_CODE_CHARACTER ? String.fromCodePoint(code) : written;
    }
  }
}

/** The string of a TEXT entity as the drawing shows it. */
export function plainText(raw: string): string {
  let oneLine = caretDecode(decodeDxfEscapes(raw)).replace(/[\r\n]/g, '');
  let end = oneLine.length;
  while (end > 0 && oneLine[end - 1] === '^') end -= 1;
  oneLine = oneLine.slice(0, end);
  return oneLine.includes('%%') ? oneLine.replace(SPECIAL_CODES, specialCharacter) : oneLine;
}

// ---------------------------------------------------------------------------------------------------------------
// MTEXT

const FLOAT = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const DIGITS = /\d+/y;
const FLOAT_OR_FACTOR = new RegExp(`${FLOAT}x?`, 'y');
const FLOAT_VALUE = new RegExp(FLOAT, 'y');
const TAB_SPACES = '    ';
const STACK_SEPARATORS = '^/#';

/** The stacked text `\S<numerator><^ or / or #><denominator>;` as the flat text `numerator/denominator`. */
function stackedText(expression: string): string {
  const characters = Array.from(expression, (character) => (character < ' ' ? ' ' : character));
  let at = 0;
  const next = (): { character: string; escaped: boolean } => {
    const escaped = characters[at] === '\\';
    if (escaped) at++;
    return { character: characters[at++] ?? '', escaped };
  };
  let numerator = '';
  let separated = false;
  while (at < characters.length) {
    const { character, escaped } = next();
    if (!escaped && character !== '' && STACK_SEPARATORS.includes(character)) {
      separated = true;
      break;
    }
    numerator += character;
  }
  if (!separated) return numerator;
  let denominator = '';
  while (at < characters.length) denominator += next().character;
  return `${numerator}/${denominator}`;
}

/** Reads the content of one MTEXT into lines of plain characters. */
class MtextReader {
  private at = 0;
  private line = '';
  private readonly lines: string[] = [];

  constructor(private readonly text: string) {}

  read(): string[] {
    while (this.at < this.text.length) this.step();
    if (this.line !== '') this.lines.push(this.line);
    return this.lines;
  }

  private step(): void {
    const character = this.text[this.at];
    if (character === '\\') this.command();
    else if (character < ' ') this.control(character);
    else if (character === '%') this.percent();
    else {
      // The braces of a group only scope properties, which are not drawn.
      if (character !== '{' && character !== '}') this.line += character;
      this.at++;
    }
  }

  private newLine(): void {
    this.lines.push(this.line);
    this.line = '';
  }

  private control(character: string): void {
    if (character === '\t') this.line += TAB_SPACES;
    else if (character === '\n') this.newLine();
    else this.line += ' ';
    this.at++;
  }

  private percent(): void {
    SPECIAL_CODE.lastIndex = this.at;
    const match = SPECIAL_CODE.exec(this.text);
    if (match === null) {
      this.line += '%';
      this.at++;
      return;
    }
    this.line += specialCharacter(match[0], match[1]);
    this.at += match[0].length;
  }

  /** Moves past a match of a sticky pattern at the current place, if there is one. */
  private skip(pattern: RegExp): void {
    pattern.lastIndex = this.at;
    const match = pattern.exec(this.text);
    if (match !== null) this.at += match[0].length;
  }

  /** The `;` that ends most commands is optional after the ones that read a number or a letter. */
  private terminator(): void {
    if (this.text[this.at] === ';') this.at++;
  }

  /** The text up to the next `;` (a `\;` is skipped when `escaped`) and the `;`, or to the end when there is none. */
  private expression(escaped: boolean): string {
    let stop = this.text.length;
    for (let i = this.at; i < this.text.length; i++) {
      if (escaped && this.text[i] === '\\' && this.text[i + 1] === ';') i++;
      else if (this.text[i] === ';') {
        stop = i;
        break;
      }
    }
    const expression = this.text.slice(this.at, stop);
    this.at = stop + 1;
    return expression;
  }

  private command(): void {
    const next = this.text[this.at + 1] ?? '';
    if (next === '\\' || next === '{' || next === '}') {
      this.line += next;
      this.at += 2;
      return;
    }
    this.at += 2;
    switch (next) {
      case '':
      case 'X':
      case 'L':
      case 'l':
      case 'O':
      case 'o':
      case 'K':
      case 'k':
        return;
      case '~':
      case 'N':
        // A column break is a space: the columns are not laid out (ezdxf `fast_plain_mtext` does the same).
        this.line += ' ';
        return;
      case 'P':
        this.newLine();
        return;
      case 'S':
        this.line += stackedText(this.expression(true));
        return;
      case 'A':
        this.at++;
        this.terminator();
        return;
      case 'C':
      case 'c':
        this.skip(DIGITS);
        this.terminator();
        return;
      case 'H':
      case 'W':
      case 'T':
        this.skip(FLOAT_OR_FACTOR);
        this.terminator();
        return;
      case 'Q':
        this.skip(FLOAT_VALUE);
        this.terminator();
        return;
      case 'p':
      case 'f':
      case 'F':
        this.expression(false);
        return;
      default:
        // A command that is none of these is text (ezdxf prints an unknown escaped letter verbatim).
        this.line += `\\${next}`;
    }
  }
}

/** The lines of an MTEXT's content as the drawing shows them. */
export function plainMtextLines(raw: string): string[] {
  return new MtextReader(caretDecode(decodeDxfEscapes(raw))).read();
}
