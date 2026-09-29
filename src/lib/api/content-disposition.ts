/**
 * `Content-Disposition: attachment` values per RFC 6266, with an RFC 5987 `filename*` parameter.
 * Stored filenames come from uploads and conversions and are untrusted, so characters that could
 * break the header are removed before either form is written.
 */

const FIRST_PRINTABLE_ASCII = 0x20;
const LAST_PRINTABLE_ASCII = 0x7e;
const DELETE_CHAR = 0x7f;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;
/** Delimiters of the quoted-string `filename` value. */
const QUOTED_STRING_DELIMITERS: ReadonlySet<string> = new Set(['"', '\\']);
const ASCII_FALLBACK_REPLACEMENT = '_';
/** Characters `encodeURIComponent` leaves as-is that are not RFC 5987 attr-char. */
const NON_ATTR_CHAR_PATTERN = /['()*]/g;
const HEX_RADIX = 16;

function isRemovedCodePoint(codePoint: number): boolean {
  if (codePoint < FIRST_PRINTABLE_ASCII || codePoint === DELETE_CHAR) {
    // Control characters, including CR and LF, which would split the header.
    return true;
  }
  // Iterating by code point leaves only unpaired surrogates in this range; they cannot be UTF-8 encoded.
  return codePoint >= FIRST_SURROGATE && codePoint <= LAST_SURROGATE;
}

function removeUnsafeCharacters(filename: string): string {
  let safe = '';
  for (const char of filename) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!isRemovedCodePoint(codePoint) && !QUOTED_STRING_DELIMITERS.has(char)) {
      safe += char;
    }
  }
  return safe;
}

function toAsciiFallback(filename: string): string {
  let fallback = '';
  for (const char of filename) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint > LAST_PRINTABLE_ASCII) {
      fallback += ASCII_FALLBACK_REPLACEMENT;
    } else {
      fallback += char;
    }
  }
  return fallback;
}

function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    NON_ATTR_CHAR_PATTERN,
    (char) => `%${char.charCodeAt(0).toString(HEX_RADIX).toUpperCase()}`
  );
}

/**
 * Builds an attachment disposition with an ASCII `filename` fallback and a UTF-8 `filename*`
 * that carries the full name.
 */
export function attachmentContentDisposition(filename: string): string {
  const safeName = removeUnsafeCharacters(filename);
  return `attachment; filename="${toAsciiFallback(safeName)}"; filename*=UTF-8''${encodeExtValue(safeName)}`;
}
