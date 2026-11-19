/*
 * A translation to TypeScript of `looks_ucs16` of libmagic (file/file, src/encoding.c, commit bbffb78dc8d764a707aa20f5c7a3b74c40c2b27c),
 * with the `text_chars` table it tests against (src/encoding.c, same commit), for the little-endian byte order mark. The licence of the
 * original file follows.
 *
 * Copyright (c) Ian F. Darwin 1986-1995.
 * Software written by Ian F. Darwin and others;
 * maintained 1995-present by Christos Zoulas and others.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice immediately at the beginning of the file, without modification,
 *    this list of conditions, and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 */

const BOM_FIRST_BYTE = 0xff;
const BOM_SECOND_BYTE = 0xfe;
const UNIT_BYTES = 2;
const BYTE_BITS = 8;
const UNIT_MASK = 0xffff;
const NONCHARACTER_FIRST = 0xfdd0;
const NONCHARACTER_LAST = 0xfdef;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;
const NONCHARACTER_FFFE = 0xfffe;
const NONCHARACTER_FFFF = 0xffff;
const ASCII_LIMIT = 0x80;
const PRINTABLE_FIRST = 0x20;
const PRINTABLE_LAST = 0x7e;
/** Control characters `text_chars` marks `T`: BEL, BS, HT, LF, VT, FF, CR, SO, SI, SUB and ESC. */
const TEXT_CONTROL_CODES: ReadonlySet<number> = new Set([0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x1a, 0x1b]);

/** `NOTTEXT`: a code below 128 that `text_chars` does not allow in text, other than U+0000. */
function isNotText(code: number): boolean {
  if (code >= ASCII_LIMIT || code === 0) return false;
  return !(code >= PRINTABLE_FIRST && code <= PRINTABLE_LAST) && !TEXT_CONTROL_CODES.has(code);
}

/**
 * Whether the bytes are UTF-16 text in little-endian order behind its mark (FF FE): no U+FFFE, U+FFFF or noncharacter U+FDD0 to U+FDEF, no
 * surrogate without its partner, and no code below 128 that text does not hold. The last byte of a buffer of odd length is left out, as
 * in the original.
 */
export function looksUcs16LittleEndian(bytes: Uint8Array): boolean {
  if (bytes.length < UNIT_BYTES || bytes[0] !== BOM_FIRST_BYTE || bytes[1] !== BOM_SECOND_BYTE) return false;
  let highSurrogatePending = false;
  for (let offset = UNIT_BYTES; offset + 1 < bytes.length; offset += UNIT_BYTES) {
    const unit = (bytes[offset] | (bytes[offset + 1] << BYTE_BITS)) & UNIT_MASK;
    if (unit === NONCHARACTER_FFFE || unit === NONCHARACTER_FFFF || (unit >= NONCHARACTER_FIRST && unit <= NONCHARACTER_LAST)) return false;
    const isLowSurrogate = unit >= LOW_SURROGATE_FIRST && unit <= LOW_SURROGATE_LAST;
    if (highSurrogatePending && !isLowSurrogate) return false;
    if (isLowSurrogate) {
      if (!highSurrogatePending) return false;
      highSurrogatePending = false;
      continue;
    }
    if (isNotText(unit)) return false;
    highSurrogatePending = unit >= HIGH_SURROGATE_FIRST && unit <= HIGH_SURROGATE_LAST;
  }
  return true;
}
