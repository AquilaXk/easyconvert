import { ConversionFailedError } from '../types';
import type { ConversionResult } from '../types';
import { openPackage } from './package-access';
import { InflateBudget } from './bounded-inflate';
import { stripOfficeMacros } from './office-macro-strip';
import { safeExtractXmlElements } from './safe-xml-scanner';
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
}

const FAMILY_FACTS: Readonly<Record<OoxmlFamily, FamilyFacts>> = {
  docx: {
    mainPart: '/word/document.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  xlsx: {
    mainPart: '/xl/workbook.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  pptx: {
    mainPart: '/ppt/presentation.xml',
    mainContentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

const CONTENT_TYPES_PART = '[Content_Types].xml';
/** Most `Default` and `Override` elements a content types part may list, as in the macro removal. */
const MAX_TYPE_ELEMENTS = 100_000;

/**
 * The variant package as the plain format of its family: the macros are removed with everything the office suite's own removal takes out
 * (`stripOfficeMacros`: parts found by content type, name or relationship, in any spelling of the markup) and the main part carries the
 * plain content type of the family, so that a template or slide show is a document, workbook or presentation. `droppedMacros` says
 * whether a macro part was removed.
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

  const stripped = await stripOfficeMacros(inputBuffer);
  const plain = stripped.buffer === inputBuffer ? zip : await openPackage(stripped.buffer, label);
  const typesPart = plain.file(CONTENT_TYPES_PART)!;
  const types = await readZipEntryText(typesPart, { budget: new InflateBudget() });
  const main = safeExtractXmlElements(types, 'Override', { maxElements: MAX_TYPE_ELEMENTS }).find((element) => element.attrs.PartName === facts.mainPart);
  if (main === undefined || main.attrs.ContentType === facts.mainContentType) return { buffer: stripped.buffer, droppedMacros: stripped.droppedMacros };
  plain.file(CONTENT_TYPES_PART, types.slice(0, main.startIndex) + main.raw.replace(/\bContentType\s*=\s*(["'])[^"']*\1/, `ContentType="${facts.mainContentType}"`) + types.slice(main.endIndex));
  return { buffer: await plain.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), droppedMacros: stripped.droppedMacros };
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
