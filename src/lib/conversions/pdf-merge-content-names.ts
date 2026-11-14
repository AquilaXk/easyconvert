/*
 * The names that a content stream (or a /DA string, which is one) takes from a resource dictionary, and the renaming of them.
 *
 * `findResourceNames` is a translation of `ResourceFinder::handleObject` and `replaceResourceNames` one of `ResourceReplacer` (the class and
 * its constructor and `handleToken`), from qpdf (https://github.com/qpdf/qpdf), tag v12.4.2, commit 4eba95899886e851cc41d76886483b347612f2a8
 * (Apache-2.0, Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger), files libqpdf/ResourceFinder.cc (SHA-256 9c565b1c...19afc38) and libqpdf/QPDFAcroFormDocumentHelper.cc
 * (SHA-256 845ce9f3...f03ee3, the anonymous namespace before `adjustDefaultAppearances`). qpdf reads a content stream with its token filter
 * machinery; this file reads it with the small tokenizer below, which is not qpdf's: it splits the bytes into names, operators and the
 * rest, and gives each token its byte range, which is all the two translated routines look at. Everything else in the file is the tokenizer.
 */

/** Resource name by the name of its type (without the slashes), as `dr_map` of qpdf: `Font` → `F1` → `F1_1`. */
export type ResourceRenames = Map<string, Map<string, string>>;
/** Offsets of each name a content stream uses, by the type of resource it names: `rnames` of qpdf. */
export type ResourceNameOffsets = Map<string, Map<string, number[]>>;

interface ContentToken {
  kind: 'name' | 'operator' | 'other';
  value: string;
  start: number;
}

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d*)$/;
const LEFT_PAREN = 0x28;
const RIGHT_PAREN = 0x29;
const BACKSLASH = 0x5c;
const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const PERCENT = 0x25;
const HASH = 0x23;
const LETTER_E = 0x45;
const LETTER_I = 0x49;
const END_OF_LINE = new Set([10, 13]);

const isRegular = (byte: number): boolean => !WHITESPACE.has(byte) && !DELIMITERS.has(byte);

function skipLiteralString(bytes: Uint8Array, from: number): number {
  let depth = 1;
  let at = from;
  while (at < bytes.length && depth > 0) {
    const byte = bytes[at];
    if (byte === BACKSLASH) at += 1;
    else if (byte === LEFT_PAREN) depth += 1;
    else if (byte === RIGHT_PAREN) depth -= 1;
    at += 1;
  }
  return at;
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  const lower = byte | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x61 + 10 : -1;
}

/** The name that starts at `from` (after its slash), with the `#xx` escapes resolved, and where it ends. */
function readName(bytes: Uint8Array, from: number): { value: string; end: number } {
  let at = from;
  let value = '';
  while (at < bytes.length && isRegular(bytes[at])) {
    const high = bytes[at] === HASH && at + 2 < bytes.length ? hexValue(bytes[at + 1]) : -1;
    const low = high >= 0 ? hexValue(bytes[at + 2]) : -1;
    if (high >= 0 && low >= 0) {
      value += String.fromCharCode(high * 16 + low);
      at += 3;
    } else {
      value += String.fromCharCode(bytes[at]);
      at += 1;
    }
  }
  return { value, end: at };
}

/** Where the data of an inline image ends: after the `EI` that follows white space and is followed by white space or the end. */
function skipInlineImage(bytes: Uint8Array, from: number): number {
  for (let at = from; at + 1 < bytes.length; at += 1) {
    const isEnd = bytes[at] === LETTER_E && bytes[at + 1] === LETTER_I && at > from && WHITESPACE.has(bytes[at - 1]);
    if (isEnd && (at + 2 >= bytes.length || WHITESPACE.has(bytes[at + 2]))) return at + 2;
  }
  return bytes.length;
}

function nextToken(bytes: Uint8Array, from: number): { token: ContentToken | null; end: number } {
  const byte = bytes[from];
  if (byte === PERCENT) {
    let at = from;
    while (at < bytes.length && !END_OF_LINE.has(bytes[at])) at += 1;
    return { token: null, end: at };
  }
  if (byte === LEFT_PAREN) return { token: { kind: 'other', value: '(', start: from }, end: skipLiteralString(bytes, from + 1) };
  if (byte === LESS_THAN && bytes[from + 1] !== LESS_THAN) {
    let at = from + 1;
    while (at < bytes.length && bytes[at] !== GREATER_THAN) at += 1;
    return { token: { kind: 'other', value: '<', start: from }, end: at + 1 };
  }
  if (byte === LESS_THAN || byte === GREATER_THAN) {
    const pair = bytes[from + 1] === byte;
    return { token: { kind: 'other', value: String.fromCharCode(byte), start: from }, end: from + (pair ? 2 : 1) };
  }
  if (byte === SLASH) {
    const { value, end } = readName(bytes, from + 1);
    return { token: { kind: 'name', value, start: from }, end };
  }
  if (!isRegular(byte)) return { token: { kind: 'other', value: String.fromCharCode(byte), start: from }, end: from + 1 };
  let at = from;
  while (at < bytes.length && isRegular(bytes[at])) at += 1;
  const word = Buffer.from(bytes.subarray(from, at)).toString('latin1');
  return { token: { kind: NUMBER.test(word) ? 'other' : 'operator', value: word, start: from }, end: word === 'ID' ? skipInlineImage(bytes, at + 1) : at };
}

function* tokens(bytes: Uint8Array): Generator<ContentToken> {
  let at = 0;
  while (at < bytes.length) {
    if (WHITESPACE.has(bytes[at])) {
      at += 1;
      continue;
    }
    const { token, end } = nextToken(bytes, at);
    if (token) yield token;
    at = Math.max(end, at + 1);
  }
}

const OPERATOR_TO_RESOURCE_TYPE = new Map([
  ['CS', 'ColorSpace'],
  ['cs', 'ColorSpace'],
  ['gs', 'ExtGState'],
  ['Tf', 'Font'],
  ['SCN', 'Pattern'],
  ['scn', 'Pattern'],
  ['BDC', 'Properties'],
  ['DP', 'Properties'],
  ['sh', 'Shading'],
  ['Do', 'XObject'],
]);

/** The resource names that `bytes` uses and where, by type of resource: the last name before an operator that takes a resource. */
export function findResourceNames(bytes: Uint8Array): ResourceNameOffsets {
  const namesByResourceType: ResourceNameOffsets = new Map();
  let lastName = '';
  let lastNameOffset = 0;
  for (const token of tokens(bytes)) {
    if (token.kind === 'operator' && lastName !== '') {
      const resourceType = OPERATOR_TO_RESOURCE_TYPE.get(token.value);
      if (resourceType === undefined) continue;
      const byName = namesByResourceType.get(resourceType) ?? new Map<string, number[]>();
      byName.set(lastName, [...(byName.get(lastName) ?? []), lastNameOffset]);
      namesByResourceType.set(resourceType, byName);
    } else if (token.kind === 'name') {
      lastName = token.value;
      lastNameOffset = token.start;
    }
  }
  return namesByResourceType;
}

/** The offset of each name to replace, by old name, and what it becomes: `to_replace` of `ResourceReplacer`'s constructor. */
function replacementsAt(renames: ResourceRenames, namesByResourceType: ResourceNameOffsets): Map<string, Map<number, string>> {
  const toReplace = new Map<string, Map<number, string>>();
  for (const [resourceType, keyOffsets] of namesByResourceType) {
    const renamesOfType = renames.get(resourceType);
    if (renamesOfType === undefined) continue;
    for (const [oldKey, offsets] of keyOffsets) {
      const newKey = renamesOfType.get(oldKey);
      if (newKey === undefined) continue;
      const atOffset = toReplace.get(oldKey) ?? new Map<number, string>();
      for (const offset of offsets) atOffset.set(offset, newKey);
      toReplace.set(oldKey, atOffset);
    }
  }
  return toReplace;
}

/**
 * `bytes` with every use of a resource name that `renames` renames written with the new name, or `null` when no name changes.
 * `encodeName` writes a name with its slash and the escapes it needs.
 */
export function replaceResourceNames(
  bytes: Uint8Array,
  renames: ResourceRenames,
  namesByResourceType: ResourceNameOffsets,
  encodeName: (name: string) => string
): Uint8Array | null {
  const toReplace = replacementsAt(renames, namesByResourceType);
  if (toReplace.size === 0) return null;
  const pieces: Buffer[] = [];
  let copiedUpTo = 0;
  for (const token of tokens(bytes)) {
    const newKey = token.kind === 'name' ? toReplace.get(token.value)?.get(token.start) : undefined;
    if (newKey === undefined) continue;
    const nameEnd = readName(bytes, token.start + 1).end;
    pieces.push(Buffer.from(bytes.subarray(copiedUpTo, token.start)), Buffer.from(encodeName(newKey), 'latin1'));
    copiedUpTo = nameEnd;
  }
  if (pieces.length === 0) return null;
  pieces.push(Buffer.from(bytes.subarray(copiedUpTo)));
  return Buffer.concat(pieces);
}
