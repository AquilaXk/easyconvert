/**
 * Escaping of text for XML and HTML markup. Each variant names the characters it replaces; none strips control
 * characters or unpaired surrogates, so a writer whose output must be well-formed XML 1.0 uses its own escaper
 * (`escapeXmlText` in `document-model/xml-text.ts`, `escapeXml` in `cad-dxf.ts` and `ocr-export.ts`).
 */

const TEXT_SPECIALS = /[&<>]/g;
const ATTRIBUTE_SPECIALS = /[&<>"]/g;
const QUOTED_SPECIALS = /[&<>"']/g;

const TEXT_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTRIBUTE_ENTITIES: Readonly<Record<string, string>> = { ...TEXT_ENTITIES, '"': '&quot;' };
const XML_QUOTED_ENTITIES: Readonly<Record<string, string>> = { ...ATTRIBUTE_ENTITIES, "'": '&apos;' };
const HTML_QUOTED_ENTITIES: Readonly<Record<string, string>> = { ...ATTRIBUTE_ENTITIES, "'": '&#39;' };

/** `&`, `<` and `>`: element content. */
export function escapeMarkupText(text: string): string {
  return text.replace(TEXT_SPECIALS, (character) => TEXT_ENTITIES[character]);
}

/** `&`, `<`, `>` and `"`: element content and double-quoted attribute values, in HTML and XML alike. The apostrophe stays. */
export function escapeMarkupAttribute(text: string): string {
  return text.replace(ATTRIBUTE_SPECIALS, (character) => ATTRIBUTE_ENTITIES[character]);
}

/** `&`, `<`, `>`, `"` and `'` (as `&apos;`): XML written by hand, where either quote may delimit an attribute. */
export function escapeXmlQuoted(text: string): string {
  return text.replace(QUOTED_SPECIALS, (character) => XML_QUOTED_ENTITIES[character]);
}

/** Like `escapeXmlQuoted` but the apostrophe is `&#39;`: `&apos;` is not an HTML 4 entity, so older HTML consumers need the numeric form. */
export function escapeHtmlQuoted(text: string): string {
  return text.replace(QUOTED_SPECIALS, (character) => HTML_QUOTED_ENTITIES[character]);
}
