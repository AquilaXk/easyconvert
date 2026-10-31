import { safeExtractXmlElements } from '../safe-xml-scanner';

/**
 * The XML without any element named `tagName`, rebuilt in one pass from the elements' positions: every one goes, however many there
 * are, since the string itself is bounded by the size of its part.
 */
export function withoutElements(xml: string, tagName: string): string {
  // The name must end there (`<w:rt>`, `<w:rt ` or `<w:rt/>`): `<w:rtl/>` alone does not send a right-to-left document through the scan.
  if (![`<${tagName}>`, `<${tagName} `, `<${tagName}/`].some((open) => xml.includes(open))) return xml;
  const kept: string[] = [];
  let from = 0;
  for (const element of safeExtractXmlElements(xml, tagName, { maxElements: Number.POSITIVE_INFINITY })) {
    kept.push(xml.slice(from, element.startIndex));
    from = element.endIndex;
  }
  kept.push(xml.slice(from));
  return kept.join('');
}
