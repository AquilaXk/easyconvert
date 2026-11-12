import { childElements, parseXmlTree, type XmlElement } from '../../conversions/xml-tree';

/**
 * Reads the Dublin Core and basic XMP properties of an XMP packet, and writes a new packet for a picture that has none. The names
 * are the ones ExifTool prints for the `dc` and `xmp` namespaces (behaviour only). A packet is read with the bounded XML reader
 * of the document packages, which has no DTD and expands no entity.
 */

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const DC = 'http://purl.org/dc/elements/1.1/';
const XMP = 'http://ns.adobe.com/xap/1.0/';
const MAX_PACKET_BYTES = 1024 * 1024;
const MAX_LIST_ITEMS = 64;
const DEFAULT_LANGUAGE = 'x-default';

export type XmpValue = string | string[];

/** The property each name stands for: its namespace, its local name and whether it is a list (rdf:Bag or rdf:Seq) or a language alternative. */
const PROPERTIES = {
  Title: { uri: DC, local: 'title', shape: 'alt' },
  Description: { uri: DC, local: 'description', shape: 'alt' },
  Rights: { uri: DC, local: 'rights', shape: 'alt' },
  Creator: { uri: DC, local: 'creator', shape: 'seq' },
  Subject: { uri: DC, local: 'subject', shape: 'bag' },
  Format: { uri: DC, local: 'format', shape: 'text' },
  CreatorTool: { uri: XMP, local: 'CreatorTool', shape: 'text' },
  CreateDate: { uri: XMP, local: 'CreateDate', shape: 'text' },
  ModifyDate: { uri: XMP, local: 'ModifyDate', shape: 'text' },
  MetadataDate: { uri: XMP, local: 'MetadataDate', shape: 'text' },
  Label: { uri: XMP, local: 'Label', shape: 'text' },
  Rating: { uri: XMP, local: 'Rating', shape: 'text' },
} as const satisfies Record<string, { uri: string; local: string; shape: 'alt' | 'seq' | 'bag' | 'text' }>;

type XmpName = keyof typeof PROPERTIES;

/** The names of the XMP properties an edit can set. */
export const WRITABLE_XMP_FIELDS: readonly string[] = ['Title', 'Description', 'Rights', 'Creator', 'Subject', 'CreatorTool'];

function textOf(element: XmlElement): string {
  return element.children
    .map((child) => (typeof child === 'string' ? child : textOf(child)))
    .join('')
    .trim();
}

function listItems(element: XmlElement): XmlElement[] {
  const container = childElements(element).find((child) => child.uri === RDF && ['Alt', 'Seq', 'Bag'].includes(child.local));
  return container ? childElements(container, 'li', RDF).slice(0, MAX_LIST_ITEMS) : [];
}

function valueOf(element: XmlElement, shape: string): XmpValue | undefined {
  if (shape === 'text') {
    const text = textOf(element);
    return text === '' ? undefined : text;
  }
  const items = listItems(element);
  if (shape === 'alt') {
    const preferred = items.find((item) => item.attrs.get('lang') === DEFAULT_LANGUAGE) ?? items[0];
    return preferred === undefined ? undefined : textOf(preferred) || undefined;
  }
  const values = items.map(textOf).filter((value) => value !== '');
  return values.length === 0 ? undefined : values;
}

function propertyValue(element: XmlElement | undefined, shape: string): XmpValue | undefined {
  return element === undefined ? undefined : valueOf(element, shape);
}

/** The properties of the packet that `PROPERTIES` names; a packet that is not well-formed XML gives none. */
export function readXmp(packet: string): Record<string, XmpValue> {
  if (Buffer.byteLength(packet, 'utf8') > MAX_PACKET_BYTES) return {};
  let root: XmlElement;
  try {
    root = parseXmlTree(packet.replace(/^﻿/, ''), 'XMP packet', 'XMP');
  } catch {
    return {};
  }
  const rdf = root.local === 'RDF' ? root : childElements(root).find((child) => child.uri === RDF && child.local === 'RDF');
  const out: Record<string, XmpValue> = {};
  for (const description of rdf ? childElements(rdf, 'Description', RDF) : []) {
    for (const [name, property] of Object.entries(PROPERTIES) as Array<[XmpName, (typeof PROPERTIES)[XmpName]]>) {
      if (name in out) continue;
      const attribute = description.attrs.get(`{${property.uri}}${property.local}`);
      const element = childElements(description, property.local, property.uri)[0];
      const value = attribute !== undefined && attribute !== '' ? attribute : propertyValue(element, property.shape);
      if (value !== undefined) out[name] = value;
    }
  }
  return out;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// eslint-disable-next-line no-control-regex -- the control characters XML 1.0 forbids
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

/** The XMP packet of `fields` (names from WRITABLE_XMP_FIELDS; a list takes an array), or null when `fields` sets nothing. */
export function buildXmp(fields: Readonly<Record<string, string | string[]>>): Buffer | null {
  const parts: string[] = [];
  let tool = '';
  for (const [name, value] of Object.entries(fields)) {
    const items = Array.isArray(value) ? value : [value];
    if (items.some((item) => XML_FORBIDDEN.test(item))) throw new RangeError(`"${name}" holds a character that XML cannot carry.`);
    const property = PROPERTIES[name as XmpName];
    if (name === 'CreatorTool') tool = ` xmp:CreatorTool="${escapeXml(items[0])}"`;
    else if (property.shape === 'alt') parts.push(`<dc:${property.local}><rdf:Alt><rdf:li xml:lang="${DEFAULT_LANGUAGE}">${escapeXml(items[0])}</rdf:li></rdf:Alt></dc:${property.local}>`);
    else {
      const container = property.shape === 'seq' ? 'Seq' : 'Bag';
      parts.push(`<dc:${property.local}><rdf:${container}>${items.map((item) => `<rdf:li>${escapeXml(item)}</rdf:li>`).join('')}</rdf:${container}></dc:${property.local}>`);
    }
  }
  if (parts.length === 0 && tool === '') return null;
  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="' + RDF + '">' +
    `<rdf:Description rdf:about="" xmlns:dc="${DC}" xmlns:xmp="${XMP}"${tool}>${parts.join('')}</rdf:Description>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  return Buffer.from(packet, 'utf8');
}

