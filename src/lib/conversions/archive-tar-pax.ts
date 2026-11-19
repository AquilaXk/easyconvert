import { ConversionFailedError } from '../types';

/** The pax extended header records of a TAR archive (IEEE 1003.1-2008 `pax`): parsed for the reader of `archive.ts`. */

const PAX_SPACE = 0x20;
const PAX_NEWLINE = 0x0a;
const PAX_EQUALS = 0x3d;
const PAX_MAX_LENGTH_DIGITS = 15;
const PAX_MAX_NUMBER_DIGITS = 18;
/** A record is "<digits> <key>=<value>\n": at least a space, a one-byte key, '=' and a newline follow the digits. */
const PAX_MIN_RECORD_TAIL = 4;
const PAX_LENGTH_PATTERN = new RegExp(`^\\d{1,${PAX_MAX_LENGTH_DIGITS}}$`);
const PAX_INTEGER_PATTERN = new RegExp(`^\\d{1,${PAX_MAX_NUMBER_DIGITS}}$`);
const PAX_DECIMAL_PATTERN = /^-?\d{1,18}(\.\d{1,18})?$/;

export function tarReadError(message: string): ConversionFailedError {
  return new ConversionFailedError(`Invalid TAR archive: ${message}`);
}

const PAX_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const ASCII_MAX_BYTE = 0x7f;

/** Decodes `data[start, end)` as strict UTF-8; pure-ASCII text skips the decoder and the slice copy. */
function decodePaxText(data: Buffer, start: number, end: number): string {
  for (let i = start; i < end; i++) {
    if (data[i] > ASCII_MAX_BYTE) return PAX_UTF8_DECODER.decode(data.subarray(start, end));
  }
  return data.toString('latin1', start, end);
}

/**
 * The pax keys the reader acts on. Only their values are decoded, as strict UTF-8; the value of any other key (`SCHILY.xattr.*`,
 * `LIBARCHIVE.xattr.*`, `uname`, vendor keys) may be binary and is skipped unread, as libarchive's `pax_attribute` consumes the value of a key it
 * does not use.
 */
const PAX_READ_KEYS: ReadonlySet<string> = new Set(['path', 'linkpath', 'size', 'mtime', 'uid', 'gid']);
const PAX_SPARSE_KEY_PREFIX = 'GNU.sparse.';

/** Parses pax records `<len> <key>=<value>\n` into the records the reader acts on; throws on any malformed length, key or encoding of those. */
export function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(PAX_SPACE, pos);
    const lengthText = space === -1 ? '' : data.toString('ascii', pos, space);
    if (!PAX_LENGTH_PATTERN.test(lengthText)) throw tarReadError('malformed pax record length');
    const length = Number(lengthText);
    const end = pos + length;
    if (
      end > data.length ||
      length < lengthText.length + PAX_MIN_RECORD_TAIL ||
      data[end - 1] !== PAX_NEWLINE
    ) {
      throw tarReadError('pax record length does not match its content');
    }
    const bodyStart = space + 1;
    const bodyEnd = end - 1;
    const equals = data.indexOf(PAX_EQUALS, bodyStart);
    if (equals <= bodyStart || equals >= bodyEnd) throw tarReadError('pax record has no key');
    let key = '';
    let value: string | null = null;
    try {
      key = decodePaxText(data, bodyStart, equals);
      if (PAX_READ_KEYS.has(key)) value = decodePaxText(data, equals + 1, bodyEnd);
    } catch {
      throw tarReadError('pax record is not valid UTF-8');
    }
    if (key.startsWith(PAX_SPARSE_KEY_PREFIX)) throw tarReadError('sparse files are not supported');
    if (value !== null) records.set(key, value);
    pos = end;
  }
  return records;
}

export function parsePaxInteger(value: string, key: string): number {
  if (!PAX_INTEGER_PATTERN.test(value)) throw tarReadError(`invalid pax ${key} record`);
  return Number(value);
}

export function parsePaxDecimal(value: string, key: string): number {
  if (!PAX_DECIMAL_PATTERN.test(value)) throw tarReadError(`invalid pax ${key} record`);
  return Number(value);
}
