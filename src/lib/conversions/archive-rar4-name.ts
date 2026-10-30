/** File header flag of RAR 4 (`LHD_UNICODE`): the name field holds the OEM name, a NUL and the encoded Unicode name. */
export const RAR4_FILE_FLAG_UNICODE = 0x0200;

const FLAG_BYTE_BITS = 8;
const COMMAND_BITS = 2;
const COMMAND_MASK = 0b11;
const COMMAND_COPY_FLAG = 0x80;
const COMMAND_COPY_LENGTH_MASK = 0x7f;
const COMMAND_COPY_MIN_LENGTH = 2;
const BYTE_MASK = 0xff;
const UTF16_UNIT_BYTES = 2;

const COMMAND_LOW_BYTE = 0;
const COMMAND_HIGH_BYTE_SHARED = 1;
const COMMAND_FULL_UNIT = 2;

/**
 * The name in a RAR 4 file header's name field. Without the Unicode flag, or with it but no NUL, the field is the name.
 * With both, it is the OEM name, a NUL, a shared high byte and commands of two bits (four to a flag byte, the first in
 * the top bits): a byte below 0x100, a byte under the shared high byte, a full little-endian unit, or a copy of the
 * OEM characters at the same positions with an optional correction added.
 *
 * Follows libarchive `read_header` in archive_read_support_format_rar.c (BSD-2-Clause, the `FHD_UNICODE` branch), which
 * stops at the end of the data and writes at most one unit per byte of the field. A decoded name may hold a NUL; the
 * entry name check refuses it, so a reader that stops at a NUL sees the same name as ours or none.
 */
export function decodeRar4FileName(field: Buffer, unicode: boolean): string {
  const nul = unicode ? field.indexOf(0) : -1;
  if (nul === -1) return field.toString('utf-8');

  const end = field.length;
  const maxUnits = end;
  const decoded = Buffer.alloc(maxUnits * UTF16_UNIT_BYTES);
  let units = 0;
  const put = (high: number, low: number): void => {
    decoded[units * UTF16_UNIT_BYTES] = low;
    decoded[units * UTF16_UNIT_BYTES + 1] = high;
    units++;
  };

  let at = nul + 1;
  const sharedHigh = at < end ? field[at++] : 0;
  let flags = 0;
  let flagBits = 0;
  while (at < end && units < maxUnits) {
    if (flagBits === 0) {
      flags = field[at++];
      flagBits = FLAG_BYTE_BITS;
    }
    flagBits -= COMMAND_BITS;
    const command = (flags >> flagBits) & COMMAND_MASK;
    if (command === COMMAND_LOW_BYTE || command === COMMAND_HIGH_BYTE_SHARED) {
      if (at >= end) break;
      put(command === COMMAND_LOW_BYTE ? 0 : sharedHigh, field[at++]);
    } else if (command === COMMAND_FULL_UNIT) {
      if (at >= end - 1) break;
      put(field[at + 1], field[at]);
      at += UTF16_UNIT_BYTES;
    } else {
      if (at >= end) break;
      const control = field[at++];
      let correction = 0;
      let high = 0;
      if ((control & COMMAND_COPY_FLAG) !== 0) {
        if (at >= end) break;
        correction = field[at++];
        high = sharedHigh;
      }
      for (let copied = (control & COMMAND_COPY_LENGTH_MASK) + COMMAND_COPY_MIN_LENGTH; copied > 0 && units < maxUnits; copied--) {
        put(high, (field[units] + correction) & BYTE_MASK);
      }
    }
  }
  return decoded.toString('utf16le', 0, units * UTF16_UNIT_BYTES);
}
