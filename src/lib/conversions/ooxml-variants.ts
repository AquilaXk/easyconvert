import { ConversionFailedError } from '../types';
import type { ConversionResult } from '../types';
import { openPackage } from './package-access';
import { readZipEntryText } from './zip-entry-reader';

/** The Office Open XML package families, each read by the reader of its plain format. */
export type OoxmlFamily = 'docx' | 'xlsx' | 'pptx';

/**
 * Macro-enabled, template and slideshow variants of the plain Office Open XML formats. They are the same package with
 * another main-part content type (and, for the macro-enabled ones, a vbaProject part), so they are read by the reader
 * of the plain format; macros are never executed.
 */
export const OOXML_VARIANT_FAMILY: Readonly<Record<string, OoxmlFamily>> = {
  docm: 'docx',
  dotx: 'docx',
  dotm: 'docx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  xltm: 'xlsx',
  pptm: 'pptx',
  potm: 'pptx',
  ppsx: 'pptx',
  ppsm: 'pptx',
};

interface FamilyFacts {
  mainPart: string;
  mainContentType: string;
  mimeType: string;
  /** The main part's relationships, where a macro project is attached. */
  mainRelationships: string;
}

const FAMILY_FACTS: Readonly<Record<OoxmlFamily, FamilyFacts>> = {
  docx: {
    mainPart: '/word/document.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    mainRelationships: 'word/_rels/document.xml.rels',
  },
  xlsx: {
    mainPart: '/xl/workbook.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    mainRelationships: 'xl/_rels/workbook.xml.rels',
  },
  pptx: {
    mainPart: '/ppt/presentation.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mainRelationships: 'ppt/_rels/presentation.xml.rels',
  },
};

const CONTENT_TYPES_PART = '[Content_Types].xml';
const MACRO_RELATIONSHIP_TYPE = /\/(vbaProject|vbaProjectSignature)$/;
const MACRO_CONTENT_TYPE = /^application\/vnd\.ms-office\.vba/;
const XML_ELEMENT = /<(Override|Default|Relationship)\b[^>]*?\/>/g;

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1];
}

function withMainContentType(element: string, contentType: string): string {
  return element.replace(/\bContentType="[^"]*"/, `ContentType="${contentType}"`);
}

/**
 * The variant package as the plain format of its family: the main part carries the plain content type and the macro
 * project, with the relationships and content types that point at it, is left out. `droppedMacros` says whether one was.
 */
export async function ooxmlVariantAsPlainPackage(
  inputBuffer: Buffer,
  variant: string,
  family: OoxmlFamily
): Promise<{ buffer: Buffer; droppedMacros: boolean }> {
  const label = variant.toUpperCase();
  const facts = FAMILY_FACTS[family];
  const zip = await openPackage(inputBuffer, label);
  const typesEntry = zip.file(CONTENT_TYPES_PART);
  if (!typesEntry) throw new ConversionFailedError(`The ${label} package has no ${CONTENT_TYPES_PART} part.`);
  if (!zip.file(facts.mainPart.slice(1))) {
    throw new ConversionFailedError(`The ${label} package has no ${facts.mainPart.slice(1)} part.`);
  }

  const macroParts = new Set<string>();
  const relationshipsEntry = zip.file(facts.mainRelationships);
  let relationships = relationshipsEntry ? await readZipEntryText(relationshipsEntry) : '';
  relationships = relationships.replace(XML_ELEMENT, (element) => {
    const type = attribute(element, 'Type');
    const target = attribute(element, 'Target');
    if (type === undefined || target === undefined || !MACRO_RELATIONSHIP_TYPE.test(type)) return element;
    macroParts.add(`${facts.mainRelationships.split('/_rels/')[0]}/${target}`);
    return '';
  });

  const types = (await readZipEntryText(typesEntry)).replace(XML_ELEMENT, (element) => {
    const contentType = attribute(element, 'ContentType');
    if (contentType === undefined) return element;
    if (MACRO_CONTENT_TYPE.test(contentType)) return '';
    return attribute(element, 'PartName') === facts.mainPart ? withMainContentType(element, facts.mainContentType) : element;
  });

  zip.file(CONTENT_TYPES_PART, types);
  if (relationshipsEntry) zip.file(facts.mainRelationships, relationships);
  for (const part of macroParts) zip.remove(part);
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return { buffer, droppedMacros: macroParts.size > 0 };
}

/** The plain-format package of a variant, as the result of converting the variant to its own family. */
export async function ooxmlVariantToPlainFormat(
  inputBuffer: Buffer,
  variant: string,
  family: OoxmlFamily,
  baseName: string
): Promise<ConversionResult> {
  const { buffer, droppedMacros } = await ooxmlVariantAsPlainPackage(inputBuffer, variant, family);
  return {
    buffer,
    mimeType: FAMILY_FACTS[family].mimeType,
    filename: `${baseName}.${family}`,
    size: buffer.length,
    ...(droppedMacros ? { metadata: { droppedMacros: true } } : {}),
  };
}
