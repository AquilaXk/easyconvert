import { SaxesParser } from 'saxes';
import { DataParseError, PayloadLimitError } from '../types';

/**
 * A small, bounded element tree for the XML parts of document packages (WordprocessingML, OPC relationships, the
 * EPUB package document). Parsing is namespace aware: elements and attributes are matched by namespace URI and local
 * name, so a package that binds `w:` to another prefix still reads. Only the five predefined entities and character
 * references expand (the parser has no DTD support), so no entity expansion can be requested.
 */

/** Most elements one part may hold; the tree costs a few hundred bytes per element. */
export const XML_TREE_MAX_ELEMENTS = 3_000_000;
/** Deepest element nesting accepted in one part. */
export const XML_TREE_MAX_DEPTH = 256;

export interface XmlElement {
  readonly uri: string;
  readonly local: string;
  readonly children: XmlNode[];
  /** Attribute values by `{uri}local` for namespaced attributes and by `local` for every attribute. */
  readonly attrs: ReadonlyMap<string, string>;
  readonly parent: XmlElement | null;
}

export type XmlNode = XmlElement | string;

/** Local name of an element that carries character data whose whitespace is significant. */
const TEXT_BEARING: ReadonlySet<string> = new Set(['t', 'delText', 'instrText']);

function isBlank(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return true;
}

/**
 * Parses `xml` into a tree. Whitespace-only text between elements is dropped; every other character-data node is
 * kept. A document that is not well formed, nests deeper than XML_TREE_MAX_DEPTH or holds more than
 * XML_TREE_MAX_ELEMENTS elements is refused with a typed error naming `partName`.
 */
export function parseXmlTree(xml: string, partName: string, packageLabel: string): XmlElement {
  const parser = new SaxesParser({ xmlns: true, position: true, defaultXMLVersion: '1.0', forceXMLVersion: true });
  let root: XmlElement | null = null;
  let current: XmlElement | null = null;
  let depth = 0;
  let count = 0;

  parser.on('error', (err) => {
    throw new DataParseError(`Invalid ${packageLabel} package: ${partName} is not well-formed XML (${err.message}).`, {
      line: parser.line,
      column: parser.column + 1,
    });
  });
  parser.on('opentag', (tag) => {
    depth += 1;
    count += 1;
    if (depth > XML_TREE_MAX_DEPTH) {
      throw new PayloadLimitError(`${partName} nests elements deeper than ${XML_TREE_MAX_DEPTH} levels.`);
    }
    if (count > XML_TREE_MAX_ELEMENTS) {
      throw new PayloadLimitError(`${partName} holds more than ${XML_TREE_MAX_ELEMENTS} elements.`);
    }
    const attrs = new Map<string, string>();
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri !== '') attrs.set(`{${attribute.uri}}${attribute.local}`, attribute.value);
      if (!attrs.has(attribute.local)) attrs.set(attribute.local, attribute.value);
    }
    const element: XmlElement = { uri: tag.uri, local: tag.local, children: [], attrs, parent: current };
    if (current) current.children.push(element);
    else root = element;
    current = element;
  });
  parser.on('closetag', () => {
    depth -= 1;
    current = current ? current.parent : null;
  });
  const onText = (text: string): void => {
    if (!current) return;
    if (isBlank(text) && !TEXT_BEARING.has(current.local)) return;
    const last = current.children[current.children.length - 1];
    if (typeof last === 'string') current.children[current.children.length - 1] = last + text;
    else current.children.push(text);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);

  parser.write(xml).close();
  if (!root) throw new DataParseError(`Invalid ${packageLabel} package: ${partName} has no root element.`);
  return root;
}

/** Child elements of `element`, optionally only those named `local` (any namespace) or `{uri}local`. */
export function childElements(element: XmlElement, local?: string, uri?: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children) {
    if (typeof child === 'string') continue;
    if (local !== undefined && child.local !== local) continue;
    if (uri !== undefined && child.uri !== uri) continue;
    found.push(child);
  }
  return found;
}

export function firstChild(element: XmlElement, local: string, uri?: string): XmlElement | undefined {
  for (const child of element.children) {
    if (typeof child === 'string') continue;
    if (child.local === local && (uri === undefined || child.uri === uri)) return child;
  }
  return undefined;
}

/** Concatenated character data of the direct text children of `element`. */
export function ownText(element: XmlElement): string {
  let text = '';
  for (const child of element.children) if (typeof child === 'string') text += child;
  return text;
}

/** Character data of `element` and all its descendants, in document order. */
export function allText(element: XmlElement): string {
  let text = '';
  const stack: XmlNode[] = [element];
  // Iterative so a deeply nested part cannot exhaust the call stack.
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    if (typeof node === 'string') {
      text += node;
    } else {
      for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
    }
  }
  return text;
}
