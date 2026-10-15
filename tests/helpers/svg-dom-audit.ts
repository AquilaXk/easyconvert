import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * Reads sanitizer output the way a browser does (parse5 is a WHATWG HTML parser, independent of the
 * sanitizer) and lists what it would run or fetch. A sanitizer test asserts that this list is empty and that
 * the surviving elements are exactly the expected ones, instead of searching the output text for strings.
 */

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

export interface AuditedElement {
  name: string;
  attributes: Record<string, string>;
}

export interface SvgAudit {
  /** Every element in document order, lower-cased name and attributes as the parser read them. */
  elements: AuditedElement[];
  /** Everything the parsed markup could execute or fetch; empty for markup that is safe to embed. */
  activeContent: string[];
  /** The text of all text nodes, joined. */
  text: string;
}

const EXECUTABLE_ELEMENTS = new Set([
  'script',
  'foreignobject',
  'iframe',
  'object',
  'embed',
  'animate',
  'set',
  'animatetransform',
  'animatemotion',
  'handler',
  'listener',
]);
/** Attributes whose value is a URL or a reference a browser follows. */
const REFERENCE_ATTRIBUTES = new Set(['href', 'xlink:href', 'src', 'action', 'formaction', 'values', 'from', 'to', 'by']);
const SCRIPT_SCHEME = /^\s*(?:javascript|vbscript|data):/i;
const EXTERNAL_URL = /(?:^|[\s("'=])(?:https?:)?\/\/[^\s)"']+/i;
const CSS_FETCH = /@import|url\(\s*["']?(?:https?:)?\/\//i;

function isElement(node: Node): node is Element {
  return 'tagName' in node && 'attrs' in node;
}

function childrenOf(node: Node): Node[] {
  return 'childNodes' in node ? node.childNodes : [];
}

export function auditSvgMarkup(markup: string): SvgAudit {
  const elements: AuditedElement[] = [];
  const activeContent: string[] = [];
  const textParts: string[] = [];

  const visit = (node: Node): void => {
    if (isElement(node)) {
      const name = node.tagName.toLowerCase();
      const attributes = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
      elements.push({ name, attributes });
      if (EXECUTABLE_ELEMENTS.has(name)) activeContent.push(`element <${name}>`);
      for (const [attrName, value] of Object.entries(attributes)) {
        const lowerName = attrName.toLowerCase();
        if (lowerName.startsWith('on')) activeContent.push(`event handler ${attrName}`);
        if (REFERENCE_ATTRIBUTES.has(lowerName) && (SCRIPT_SCHEME.test(value) || EXTERNAL_URL.test(value))) {
          activeContent.push(`${attrName}="${value}"`);
        }
        if (lowerName === 'style' && CSS_FETCH.test(value)) activeContent.push(`style="${value}"`);
      }
      if (name === 'style') {
        const css = childrenOf(node)
          .map((child) => ('value' in child ? String(child.value) : ''))
          .join('');
        if (CSS_FETCH.test(css)) activeContent.push(`<style> fetching: ${css.trim()}`);
      }
    } else if (node.nodeName === '#text') {
      textParts.push((node as DefaultTreeAdapterMap['textNode']).value);
    }
    for (const child of childrenOf(node)) visit(child);
  };

  visit(parseFragment(markup));
  return { elements, activeContent, text: textParts.join('') };
}

export interface SvgShape {
  name: string;
  attributes: Record<string, string>;
  /** The element's text content, whitespace collapsed. */
  text: string;
}

function textContentOf(node: Node): string {
  if (node.nodeName === '#text') return (node as DefaultTreeAdapterMap['textNode']).value;
  return childrenOf(node).map(textContentOf).join('');
}

/** The elements of `markup` named in `names`, in document order, each with its attributes and text. */
export function readSvgShapes(markup: string, names: ReadonlySet<string>): SvgShape[] {
  const shapes: SvgShape[] = [];
  const visit = (node: Node): void => {
    if (isElement(node) && names.has(node.tagName.toLowerCase())) {
      shapes.push({
        name: node.tagName.toLowerCase(),
        attributes: Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value])),
        text: textContentOf(node).replace(/\s+/g, ' ').trim(),
      });
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(parseFragment(markup));
  return shapes;
}
