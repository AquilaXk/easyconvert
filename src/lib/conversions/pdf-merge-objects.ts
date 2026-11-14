import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';

/** Reads of a pdf-lib object graph that the merge code shares: a value looked up through its reference and checked for its type. */

export const name = (key: string): PDFName => PDFName.of(key);

export function dictAt(context: PDFContext, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function arrayAt(context: PDFContext, value: PDFObject | undefined): PDFArray | undefined {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFArray ? resolved : undefined;
}

export function numberAt(context: PDFContext, value: PDFObject | undefined): number | undefined {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
}

/** The text of a string object (`decodeText`: PDFDocEncoding or UTF-16), or undefined when the value is no string. */
export function textAt(context: PDFContext, value: PDFObject | undefined): string | undefined {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFString || resolved instanceof PDFHexString ? resolved.decodeText() : undefined;
}

export function nameAt(context: PDFContext, value: PDFObject | undefined): string | undefined {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFName ? resolved.decodeText() : undefined;
}

/** The items of an array that are references; a direct item is no object a merge can keep track of. */
export function refsOf(array: PDFArray | undefined): PDFRef[] {
  const refs: PDFRef[] = [];
  for (let at = 0; array && at < array.size(); at += 1) {
    const item = array.get(at);
    if (item instanceof PDFRef) refs.push(item);
  }
  return refs;
}

const OCTAL_ESCAPE_WIDTH = 3;
const PRINTABLE_LOW = 0x20;
const PRINTABLE_HIGH = 0x7e;
const BYTE_ESCAPES = new Map([[0x28, '\\('], [0x29, '\\)'], [0x5c, '\\\\'], [0x0a, '\\n'], [0x0d, '\\r']]);

/** A literal string object holding `bytes`: the parentheses, the backslash and the bytes that are no printable ASCII are escaped. */
export function stringFromBytes(bytes: Uint8Array): PDFString {
  let syntax = '';
  for (const byte of bytes) {
    const escaped = BYTE_ESCAPES.get(byte);
    if (escaped !== undefined) syntax += escaped;
    else if (byte < PRINTABLE_LOW || byte > PRINTABLE_HIGH) syntax += `\\${byte.toString(8).padStart(OCTAL_ESCAPE_WIDTH, '0')}`;
    else syntax += String.fromCharCode(byte);
  }
  return PDFString.of(syntax);
}

/** A string object for `text`: a literal string when it is ASCII, UTF-16 otherwise. */
export function textObject(text: string): PDFString | PDFHexString {
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(text) ? stringFromBytes(Buffer.from(text, 'latin1')) : PDFHexString.fromText(text);
}

/** A new dictionary or array with the entries of `value`, as `QPDFObjectHandle::shallowCopy`; any other object is returned as it is. */
export function shallowCopy(context: PDFContext, value: PDFObject): PDFObject {
  return value instanceof PDFDict || value instanceof PDFArray ? value.clone(context) : value;
}
