import { safeDecodeXmlEntities, safeExtractXmlElements, type SafeXmlElement, type SafeXmlScannerOptions } from '../safe-xml-scanner';

/**
 * Returns the first matching element in linear time, or null if not found.
 */
export function safeExtractFirstXmlElement(
  xml: string,
  tagName: string | string[],
  options?: SafeXmlScannerOptions
): SafeXmlElement | null {
  const elements = safeExtractXmlElements(xml, tagName, { ...options, maxElements: 1 });
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Safely extracts inner XML content of the first matching tag.
 */
export function safeExtractTagContent(xml: string, tagName: string | string[]): string | null {
  const el = safeExtractFirstXmlElement(xml, tagName);
  return el ? el.content : null;
}

/**
 * Extracts and decodes all text content from specified tags (e.g. w:t, a:t, text:p)
 * or strips tags linearly in O(N).
 */
export function safeExtractAllText(xml: string, tagName?: string): string {
  if (!xml) return '';
  if (tagName) {
    const elements = safeExtractXmlElements(xml, tagName);
    return elements.map((e) => safeDecodeXmlEntities(e.content.replace(/<[^>]+>/g, ''))).join('');
  }
  return safeDecodeXmlEntities(xml.replace(/<[^>]+>/g, ''));
}

/**
 * Navigates linearly down an element hierarchy path (e.g. ['p:grpSpPr', 'a:xfrm', 'a:off']).
 * Replaces dangerous chained regexes with deterministic O(N) depth-bounded traversal.
 */
export function safeFindXmlPath(xml: string, path: string[]): SafeXmlElement | null {
  let currentXml = xml;
  let currentEl: SafeXmlElement | null = null;
  for (const step of path) {
    currentEl = safeExtractFirstXmlElement(currentXml, step);
    if (!currentEl) return null;
    currentXml = currentEl.content;
  }
  return currentEl;
}

/**
 * Safely extracts hex color from solidFill or srgbClr elements without regex backtracking.
 */
export function safeFindColor(xml: string, parentPath: string[] = []): string | undefined {
  const targetXml = parentPath.length > 0 ? safeFindXmlPath(xml, parentPath)?.content : xml;
  if (!targetXml) return undefined;
  const srgbEl = safeExtractFirstXmlElement(targetXml, 'a:srgbClr') || safeExtractFirstXmlElement(targetXml, 'srgbClr');
  if (srgbEl && srgbEl.attrs.val && /^[A-Fa-f0-9]{6}$/.test(srgbEl.attrs.val)) {
    return `#${srgbEl.attrs.val}`;
  }
  return undefined;
}

export function safeExtractXmlTags(xml: string, tagName: string): string[] {
  return safeExtractXmlElements(xml, tagName).map((e) => e.raw);
}

export function safeExtractDocxBlocks(bodyXml: string): string[] {
  return safeExtractXmlElements(bodyXml, ['w:tbl', 'w:p', 'w:drawing']).map((el) => el.raw);
}
