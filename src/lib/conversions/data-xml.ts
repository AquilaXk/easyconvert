import { SaxesParser } from 'saxes';
import { DataLimitExceededError, DataParseError, DataRepresentationError } from '../types';
import { MAX_DATA_NESTING_DEPTH, isDataObject, setOwn, type DataObject, type DataValue } from './data-json';

/**
 * XML for data conversions, parsed by saxes (a conformant, namespace-aware XML 1.0 parser).
 *
 * XML <-> JSON mapping convention: JsonML (http://www.jsonml.org/), wrapped in the envelope
 * {"$jsonml": tree} so that it cannot be confused with ordinary JSON arrays. An element is the array
 * [qualifiedName, {attributes}?, ...children]. The attributes object appears only when the
 * element has attributes and keeps their document order; each child is an element array or a
 * string of character data. Adjacent character data (text, CDATA sections, expanded references)
 * forms one string and whitespace-only text is kept, so the tree serializes back to the same
 * canonical XML. Namespace declarations stay ordinary attributes (xmlns, xmlns:p) and names keep
 * their prefixes. Comments, processing instructions, the XML declaration and the DOCTYPE are
 * not data and are dropped; DTD attribute defaults are not applied.
 *
 * Entities: the five predefined entities and character references are always decoded. General
 * entities declared in the internal DTD subset are expanded within the limits below. External
 * entities are never fetched (no XXE), and parameter entities, unparsed entities and entities
 * whose replacement text contains markup are rejected rather than half-processed. Whitespace in
 * an entity's replacement text referenced from an attribute value is not normalized to spaces.
 */

export interface XmlElement {
  name: string;
  /** [qualifiedName, value] in document order. */
  attributes: [string, string][];
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

/** Deepest chain of entity references inside entity replacement text. */
const MAX_XML_ENTITY_DEPTH = 16;
/** Longest replacement text one entity may expand to. */
const MAX_XML_ENTITY_CHARS = 1_000_000;
/** Characters all entity references of a document may insert, per character of input. */
const XML_ENTITY_AMPLIFICATION = 4;
/**
 * Characters all entity references of one document may insert, whatever its size. Without a
 * ceiling a 50 MB input could expand past V8's string limit (an untyped RangeError) after
 * seconds of work.
 */
const MAX_XML_EXPANDED_CHARS = 16_000_000;

/** Insertion budget of a document: proportional to its size, between one entity's cap and the absolute cap. */
function entityBudget(inputChars: number): number {
  return Math.min(MAX_XML_EXPANDED_CHARS, Math.max(MAX_XML_ENTITY_CHARS, inputChars * XML_ENTITY_AMPLIFICATION));
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>';
/** JsonML position of the optional attributes object, right after the element name. */
const JSONML_ATTRIBUTES_INDEX = 1;
/** Repeated sibling elements that make a wrapper element a record list. */
const MIN_RECORD_LIST_LENGTH = 2;
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['apos', "'"],
  ['quot', '"'],
]);
const HEX_RADIX = 16;
const MAX_CODE_POINT = 0x10ffff;
const DECIMAL_RADIX = 10;
const CODE_POINT_HEX_DIGITS = 4;

const NAME_START_CHARS =
  'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D' +
  '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_CHARS = `${NAME_START_CHARS}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NCNAME = `[${NAME_START_CHARS}][${NAME_CHARS}]*`;
const QNAME_PATTERN = new RegExp(`^${NCNAME}(?::${NCNAME})?$`, 'u');
const DTD_NAME = new RegExp(`[:${NAME_START_CHARS}][:${NAME_CHARS}]*`, 'uy');
const NCNAME_START_PATTERN = new RegExp(`^[${NAME_START_CHARS}]`, 'u');
const NON_NCNAME_CHAR = new RegExp(`[^${NAME_CHARS}]`, 'gu');
const NON_XML_CHAR = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/u;
const DTD_WHITESPACE = /[\x20\t\r\n]+/y;
/** Characters of unexpected DTD content quoted in an error message. */
const DTD_EXCERPT_CHARS = 20;
const CHARACTER_REFERENCE = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/;

function codePointLabel(char: string): string {
  return `U+${(char.codePointAt(0) ?? 0).toString(HEX_RADIX).toUpperCase().padStart(CODE_POINT_HEX_DIGITS, '0')}`;
}

function isXmlCharacterData(text: string): boolean {
  return !NON_XML_CHAR.test(text);
}

// ---------------------------------------------------------------------------
// Internal DTD subset: general entity declarations
// ---------------------------------------------------------------------------

type EntityDeclaration =
  | { kind: 'internal'; replacement: string }
  | { kind: 'external' }
  | { kind: 'unparsed' };

function dtdError(message: string): DataParseError {
  return new DataParseError(`XML parsing failed: ${message}`);
}

function decodeCharacterReference(reference: string): string {
  const match = CHARACTER_REFERENCE.exec(reference);
  if (!match) throw dtdError(`malformed character reference &${reference};.`);
  const codePoint = match[1] !== undefined ? parseInt(match[1], HEX_RADIX) : parseInt(match[2], DECIMAL_RADIX);
  const char = codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : '';
  if (char === '' || !isXmlCharacterData(char)) throw dtdError(`character reference &${reference}; is not an XML character.`);
  return char;
}

/** An entity value literal as stored (XML 1.0 4.5): character references expanded, general entity references kept. */
function entityReplacementText(literal: string, name: string): string {
  if (literal.includes('%')) {
    throw dtdError(`parameter entity references are not supported (entity ${name}).`);
  }
  return literal.replace(/&(#[^;]*);/g, (_, reference: string) => decodeCharacterReference(reference));
}

class InternalSubsetReader {
  private pos = 0;
  readonly entities = new Map<string, EntityDeclaration>();

  constructor(private readonly subset: string) {}

  read(): Map<string, EntityDeclaration> {
    for (;;) {
      this.skipWhitespace();
      if (this.pos >= this.subset.length) return this.entities;
      if (this.consume('<!--')) {
        this.skipPast('-->');
      } else if (this.consume('<?')) {
        this.skipPast('?>');
      } else if (this.consume('<!ENTITY')) {
        this.readEntityDeclaration();
      } else if (this.subset.startsWith('<!', this.pos)) {
        this.skipMarkupDeclaration();
      } else if (this.subset[this.pos] === '%') {
        throw dtdError('parameter entity references are not supported.');
      } else {
        const excerpt = this.subset.slice(this.pos, this.pos + DTD_EXCERPT_CHARS);
        throw dtdError(`unexpected content in the internal DTD subset: ${JSON.stringify(excerpt)}.`);
      }
    }
  }

  private consume(token: string): boolean {
    if (!this.subset.startsWith(token, this.pos)) return false;
    this.pos += token.length;
    return true;
  }

  private matchAt(pattern: RegExp): string | null {
    pattern.lastIndex = this.pos;
    const match = pattern.exec(this.subset);
    if (!match) return null;
    this.pos += match[0].length;
    return match[0];
  }

  private skipWhitespace(): boolean {
    return this.matchAt(DTD_WHITESPACE) !== null;
  }

  private skipPast(terminator: string): void {
    const end = this.subset.indexOf(terminator, this.pos);
    if (end === -1) throw dtdError(`unterminated declaration in the internal DTD subset (missing ${terminator}).`);
    this.pos = end + terminator.length;
  }

  private readQuoted(): string {
    const quote = this.subset[this.pos];
    if (quote !== '"' && quote !== "'") throw dtdError('expected a quoted literal in the internal DTD subset.');
    const end = this.subset.indexOf(quote, this.pos + 1);
    if (end === -1) throw dtdError('unterminated literal in the internal DTD subset.');
    const literal = this.subset.slice(this.pos + 1, end);
    this.pos = end + 1;
    return literal;
  }

  private readName(): string {
    const name = this.matchAt(DTD_NAME);
    if (name === null) throw dtdError('expected a name in the internal DTD subset.');
    return name;
  }

  /** Skips ELEMENT, ATTLIST and NOTATION declarations; quoted literals may contain '>'. */
  private skipMarkupDeclaration(): void {
    while (this.pos < this.subset.length) {
      const c = this.subset[this.pos];
      if (c === '"' || c === "'") {
        this.readQuoted();
      } else {
        this.pos++;
        if (c === '>') return;
      }
    }
    throw dtdError('unterminated markup declaration in the internal DTD subset.');
  }

  private readEntityDeclaration(): void {
    if (!this.skipWhitespace()) throw dtdError('expected whitespace after <!ENTITY.');
    const parameter = this.consume('%');
    if (parameter) this.skipWhitespace();
    const name = this.readName();
    if (!this.skipWhitespace()) throw dtdError(`expected whitespace after the entity name ${name}.`);
    let declaration: EntityDeclaration;
    const c = this.subset[this.pos];
    if (c === '"' || c === "'") {
      declaration = { kind: 'internal', replacement: entityReplacementText(this.readQuoted(), name) };
    } else {
      if (this.consume('PUBLIC')) {
        this.skipWhitespace();
        this.readQuoted();
      } else if (!this.consume('SYSTEM')) {
        throw dtdError(`expected a literal, SYSTEM or PUBLIC in the declaration of ${name}.`);
      }
      this.skipWhitespace();
      this.readQuoted();
      const spaced = this.skipWhitespace();
      declaration = spaced && this.consume('NDATA') ? { kind: 'unparsed' } : { kind: 'external' };
      if (declaration.kind === 'unparsed') {
        this.skipWhitespace();
        this.readName();
      }
    }
    this.skipWhitespace();
    if (!this.consume('>')) throw dtdError(`expected '>' to close the declaration of ${name}.`);
    // Parameter entities are never referenced (a reference is rejected), so only general ones are kept.
    // The first declaration of a name is binding.
    if (!parameter && !this.entities.has(name)) this.entities.set(name, declaration);
  }
}

/** The internal subset of a DOCTYPE as reported by saxes (the text between "<!DOCTYPE" and ">"). */
function internalSubsetOf(doctype: string): string | null {
  let pos = 0;
  while (pos < doctype.length && doctype[pos] !== '[') {
    const c = doctype[pos];
    if (c === '"' || c === "'") {
      const end = doctype.indexOf(c, pos + 1);
      if (end === -1) throw dtdError('unterminated literal in the DOCTYPE.');
      pos = end + 1;
    } else {
      pos++;
    }
  }
  if (pos >= doctype.length) return null;
  const end = doctype.lastIndexOf(']');
  if (end < pos) throw dtdError('unterminated internal DTD subset.');
  return doctype.slice(pos + 1, end);
}

class EntityExpander {
  private declarations = new Map<string, EntityDeclaration>();
  private readonly expanded = new Map<string, string>();
  private inserted = 0;

  constructor(private readonly documentBudget: number) {}

  declare(declarations: Map<string, EntityDeclaration>): void {
    this.declarations = declarations;
  }

  /** Replacement text for a reference in the document; undefined lets the parser report it as undefined. */
  reference(name: string): string | undefined {
    if (!this.declarations.has(name)) return undefined;
    const value = this.expand(name, []);
    // Checked before the parser appends the text, so the budget is never overshot.
    if (this.inserted + value.length > this.documentBudget) {
      throw new DataLimitExceededError(`XML entity expansion exceeds ${this.documentBudget} characters for this document.`);
    }
    this.inserted += value.length;
    return value;
  }

  private expand(name: string, chain: string[]): string {
    const cached = this.expanded.get(name);
    if (cached !== undefined) return cached;
    if (chain.includes(name)) {
      throw dtdError(`recursive entity reference &${name}; (${[...chain, name].join(' -> ')}).`);
    }
    if (chain.length >= MAX_XML_ENTITY_DEPTH) {
      throw new DataLimitExceededError(`XML entity expansion nests deeper than ${MAX_XML_ENTITY_DEPTH} references.`);
    }
    const declaration = this.declarations.get(name);
    if (!declaration) throw dtdError(`undefined entity &${name};.`);
    if (declaration.kind === 'external') {
      throw dtdError(`external entity &${name}; is not loaded; external entities are disabled.`);
    }
    if (declaration.kind === 'unparsed') {
      throw dtdError(`unparsed entity &${name}; cannot be referenced in content.`);
    }
    const replacement = declaration.replacement;
    let out = '';
    const append = (piece: string): void => {
      if (out.length + piece.length > MAX_XML_ENTITY_CHARS) {
        throw new DataLimitExceededError(`XML entity expansion of &${name}; exceeds ${MAX_XML_ENTITY_CHARS} characters.`);
      }
      out += piece;
    };
    let pos = 0;
    while (pos < replacement.length) {
      const amp = replacement.indexOf('&', pos);
      const lt = replacement.indexOf('<', pos);
      if (lt !== -1 && (amp === -1 || lt < amp)) {
        throw dtdError(`entity &${name}; contains markup, which data conversion does not expand.`);
      }
      if (amp === -1) {
        append(replacement.slice(pos));
        break;
      }
      append(replacement.slice(pos, amp));
      const end = replacement.indexOf(';', amp);
      if (end === -1) throw dtdError(`unterminated reference in entity &${name};.`);
      const reference = replacement.slice(amp + 1, end);
      if (reference.startsWith('#')) {
        append(decodeCharacterReference(reference));
      } else {
        append(PREDEFINED_ENTITIES.get(reference) ?? this.expand(reference, [...chain, name]));
      }
      pos = end + 1;
    }
    this.expanded.set(name, out);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function appendText(parent: XmlElement, text: string): void {
  if (text === '') return;
  const last = parent.children.length - 1;
  if (last >= 0 && typeof parent.children[last] === 'string') {
    parent.children[last] = (parent.children[last] as string) + text;
  } else {
    parent.children.push(text);
  }
}

/**
 * Parses a decoded XML document into its element tree. Any well-formedness or namespace error
 * throws DataParseError with the line; entity limits throw DataLimitExceededError.
 */
export function parseXmlDocument(text: string): XmlElement {
  const parser = new SaxesParser({ xmlns: true, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  const expander = new EntityExpander(entityBudget(text.length));
  parser.ENTITIES = new Proxy(parser.ENTITIES, {
    get(target, name, receiver) {
      if (typeof name !== 'string' || PREDEFINED_ENTITIES.has(name)) return Reflect.get(target, name, receiver);
      return expander.reference(name);
    },
  });

  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  parser.on('error', (err) => {
    throw new DataParseError(`XML parsing failed: ${err.message}`, { line: parser.line, column: parser.column + 1 });
  });
  parser.on('doctype', (doctype) => {
    const subset = internalSubsetOf(doctype);
    if (subset !== null) expander.declare(new InternalSubsetReader(subset).read());
  });
  parser.on('opentag', (tag) => {
    if (stack.length >= MAX_DATA_NESTING_DEPTH) {
      throw new DataLimitExceededError(`XML element nesting exceeds ${MAX_DATA_NESTING_DEPTH} levels.`);
    }
    const element: XmlElement = {
      name: tag.name,
      attributes: Object.values(tag.attributes).map((attribute) => [attribute.name, attribute.value]),
      children: [],
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else root = element;
    stack.push(element);
  });
  parser.on('closetag', () => {
    stack.pop();
  });
  // Text outside the document element can only be whitespace; it is not part of the data.
  parser.on('text', (chunk) => {
    const parent = stack[stack.length - 1];
    if (parent) appendText(parent, chunk);
  });
  parser.on('cdata', (chunk) => {
    const parent = stack[stack.length - 1];
    if (parent) appendText(parent, chunk);
  });

  try {
    parser.write(text).close();
  } catch (err) {
    // DTD and entity errors are raised from handlers that do not know the position; add it here.
    if (err instanceof DataParseError && err.line === undefined) {
      throw new DataParseError(err.message, { line: parser.line, column: parser.column + 1 });
    }
    throw err;
  }
  if (!root) throw new DataParseError('XML parsing failed: document must contain a root element.');
  return root;
}

// ---------------------------------------------------------------------------
// Tree views: JsonML, text, records
// ---------------------------------------------------------------------------

/** The single key of the object whose value is a JsonML tree, in both directions. */
export const JSONML_KEY = '$jsonml';

export function xmlToJsonMl(element: XmlElement): DataValue {
  const node: DataValue[] = [element.name];
  if (element.attributes.length > 0) {
    const attributes: DataObject = {};
    for (const [name, value] of element.attributes) setOwn(attributes, name, value);
    node.push(attributes);
  }
  for (const child of element.children) {
    node.push(typeof child === 'string' ? child : xmlToJsonMl(child));
  }
  return node;
}

/** The JSON value of an XML document: its JsonML tree in the {"$jsonml": tree} envelope. */
export function xmlToJsonMlDocument(root: XmlElement): DataObject {
  const envelope: DataObject = {};
  setOwn(envelope, JSONML_KEY, xmlToJsonMl(root));
  return envelope;
}

/** XPath string-value of the element: all character data of its descendants in document order. */
export function xmlStringValue(element: XmlElement): string {
  const parts: string[] = [];
  const collect = (node: XmlElement): void => {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child);
      else collect(child);
    }
  };
  collect(element);
  return parts.join('');
}

function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((child): child is XmlElement => typeof child !== 'string');
}

/**
 * Attributes as "$name", child elements by name (repeats become arrays), mixed text as "#text".
 * Neither "$" nor "#" can start an XML name, so the keys never collide; "@" is avoided because a
 * leading "@" is a spreadsheet formula trigger and would be escaped in every CSV header.
 */
function elementRecord(element: XmlElement): DataObject {
  const record: DataObject = {};
  for (const [name, value] of element.attributes) setOwn(record, `$${name}`, value);
  const elements = childElements(element);
  if (elements.length === 0) {
    const text = xmlStringValue(element);
    if (text !== '' || element.attributes.length === 0) setOwn(record, '#text', text);
    return record;
  }
  for (const child of elements) {
    const simple = child.attributes.length === 0 && childElements(child).length === 0;
    const value: DataValue = simple ? xmlStringValue(child) : elementRecord(child);
    const existing = Object.prototype.hasOwnProperty.call(record, child.name) ? record[child.name] : undefined;
    if (existing === undefined) setOwn(record, child.name, value);
    else if (Array.isArray(existing)) existing.push(value);
    else setOwn(record, child.name, [existing, value]);
  }
  const directText = element.children.filter((child): child is string => typeof child === 'string').join('');
  if (directText.trim() !== '') setOwn(record, '#text', directText);
  return record;
}

/**
 * Table records of a data document: one per child element of the document element, after
 * descending through single wrapper elements around a repeated list (<root><items><item/>...).
 */
export function xmlRecords(root: XmlElement): DataObject[] {
  let container = root;
  for (;;) {
    const children = childElements(container);
    const grandchildren = children.length === 1 ? childElements(children[0]) : [];
    const isList =
      grandchildren.length >= MIN_RECORD_LIST_LENGTH && grandchildren.every((child) => child.name === grandchildren[0].name);
    if (!isList) break;
    container = children[0];
  }
  const records = childElements(container);
  return records.length === 0 ? [elementRecord(container)] : records.map(elementRecord);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function checkedCharacterData(text: string): string {
  const bad = NON_XML_CHAR.exec(text);
  if (bad) {
    throw new DataRepresentationError(`XML 1.0 cannot represent the character ${codePointLabel(bad[0])}.`);
  }
  return text;
}

function escapeText(text: string): string {
  return checkedCharacterData(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r/g, '&#13;');
}

function escapeAttribute(text: string): string {
  return checkedCharacterData(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

function scalarText(value: DataValue): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'INF' : '-INF';
  }
  return String(value);
}

type JsonMlElement = [string, ...DataValue[]];

/**
 * Whether a value is JsonML as xmlToJsonMl produces it: [QName, non-empty attributes?, ...children]
 * where children are non-empty strings (never two in a row) or such elements.
 */
function isJsonMlElement(value: DataValue, depth = 0): value is JsonMlElement {
  if (!Array.isArray(value) || typeof value[0] !== 'string' || !QNAME_PATTERN.test(value[0])) return false;
  if (depth >= MAX_DATA_NESTING_DEPTH) return false;
  let index = JSONML_ATTRIBUTES_INDEX;
  const attributes = value[JSONML_ATTRIBUTES_INDEX];
  if (isDataObject(attributes)) {
    const entries = Object.entries(attributes);
    if (entries.length === 0) return false;
    for (const [name, attribute] of entries) {
      if (!QNAME_PATTERN.test(name) || attribute === null || typeof attribute === 'object') return false;
    }
    index = JSONML_ATTRIBUTES_INDEX + 1;
  }
  let previousWasText = false;
  for (const child of value.slice(index)) {
    if (typeof child === 'string') {
      if (child === '' || previousWasText) return false;
      previousWasText = true;
    } else if (isJsonMlElement(child, depth + 1)) {
      previousWasText = false;
    } else {
      return false;
    }
  }
  return true;
}

function writeJsonMlElement(element: JsonMlElement, out: string[]): void {
  const [name] = element;
  out.push('<', name);
  let index = JSONML_ATTRIBUTES_INDEX;
  const attributes = element[JSONML_ATTRIBUTES_INDEX];
  if (isDataObject(attributes)) {
    for (const [attribute, value] of Object.entries(attributes)) {
      out.push(' ', attribute, '="', escapeAttribute(scalarText(value)), '"');
    }
    index = JSONML_ATTRIBUTES_INDEX + 1;
  }
  if (index >= element.length) {
    out.push('/>');
    return;
  }
  out.push('>');
  for (const child of element.slice(index)) {
    if (typeof child === 'string') out.push(escapeText(child));
    else writeJsonMlElement(child as JsonMlElement, out);
  }
  out.push('</', name, '>');
}

/** An XML element name for an arbitrary JSON key: invalid characters become "_", a bad start gets a "_" prefix. */
function elementNameForKey(key: string): string {
  if (key === '') throw new DataRepresentationError('An empty JSON key cannot become an XML element name.');
  const name = key.replace(NON_NCNAME_CHAR, '_');
  return NCNAME_START_PATTERN.test(name) ? name : `_${name}`;
}

/**
 * Element names for an object's keys. Distinct keys that map to the same name ("a b", "a_b",
 * "a:b") would merge into one repeated element on the way back, so they are rejected.
 */
function elementNamesForKeys(keys: string[]): string[] {
  const keyByName = new Map<string, string>();
  return keys.map((key) => {
    const name = elementNameForKey(key);
    const earlier = keyByName.get(name);
    if (earlier !== undefined) {
      throw new DataRepresentationError(`JSON keys "${earlier}" and "${key}" would both become the XML element <${name}>.`);
    }
    keyByName.set(name, key);
    return name;
  });
}

/** Generic mapping: objects become child elements per key, arrays repeat the element (top level: item). */
function writeGenericElement(value: DataValue, tag: string, out: string[], depth: number): void {
  if (depth > MAX_DATA_NESTING_DEPTH) {
    throw new DataLimitExceededError(`Data nesting exceeds ${MAX_DATA_NESTING_DEPTH} levels.`);
  }
  if (value === null) {
    out.push('<', tag, '/>');
    return;
  }
  out.push('<', tag, '>');
  if (Array.isArray(value)) {
    for (const item of value) writeGenericElement(item, 'item', out, depth + 1);
  } else if (isDataObject(value)) {
    const entries = Object.entries(value);
    const names = elementNamesForKeys(entries.map(([key]) => key));
    for (const [index, [, child]] of entries.entries()) {
      const name = names[index];
      if (Array.isArray(child)) {
        for (const item of child) writeGenericElement(item, name, out, depth + 1);
      } else {
        writeGenericElement(child, name, out, depth + 1);
      }
    }
  } else {
    out.push(escapeText(scalarText(value)));
  }
  out.push('</', tag, '>');
}

/** The JsonML tree when the value is the {"$jsonml": tree} envelope (an object with that single key). */
function jsonMlEnvelopeContent(value: DataValue): { tree: DataValue } | null {
  if (!isDataObject(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== JSONML_KEY) return null;
  return { tree: value[JSONML_KEY] };
}

/**
 * Writes XML from data: a JsonML tree in its {"$jsonml": tree} envelope (as produced from XML) is
 * written back exactly, any other value through the generic element mapping under <root>, even
 * an array that happens to look like JsonML. The generic mapping only emits
 * unprefixed names and escaped, checked character data, so it is well-formed by construction;
 * JsonML names carry prefixes that must be declared, so that output is re-parsed and a namespace
 * problem fails here instead of reaching the user as malformed XML.
 */
export function serializeDataToXml(value: DataValue): string {
  const out: string[] = [XML_DECLARATION, '\n'];
  const envelope = jsonMlEnvelopeContent(value);
  if (envelope === null) {
    writeGenericElement(value, 'root', out, 0);
    return out.join('');
  }
  if (!isJsonMlElement(envelope.tree)) {
    throw new DataRepresentationError(
      `The "${JSONML_KEY}" value is not a JsonML element: [name, {attributes}?, ...children].`
    );
  }
  writeJsonMlElement(envelope.tree, out);
  const xml = out.join('');
  try {
    parseXmlDocument(xml);
  } catch (err) {
    if (err instanceof DataParseError) {
      throw new DataRepresentationError(`The data cannot be written as well-formed XML: ${err.message}`);
    }
    throw err;
  }
  return xml;
}
