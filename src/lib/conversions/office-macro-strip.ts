import JSZip from 'jszip';
import { InflateBudget } from './bounded-inflate';
import { startsWithBytes, ZIP_LOCAL_HEADER_SIGNATURE } from './package-access';
import { readZipEntryText } from './zip-entry-reader';

/**
 * Removes the macros of an Office Open XML or OpenDocument package by what the package holds, not by what it is called. A `.docx` that
 * carries a `vbaProject.bin` (a macro-enabled document renamed) or an `.odt` with a Basic library is as dangerous as the `.docm` or the
 * `.odm` the format names say, so the check is made on every package the office suite is handed.
 *
 *  - Office Open XML: the parts whose content type is a VBA project (`application/vnd.ms-office.vbaProject`, its signature, and the Word
 *    `vbaData`) or whose name is `vbaProject.bin`, `vbaProjectSignature.bin` or `vbaData.xml`; the relationships that point at them in any
 *    part; their entries in `[Content_Types].xml`; and the macro-enabled content type of the main part, which becomes the plain one so
 *    that the package is the plain format the office suite opens.
 *  - OpenDocument: the `Basic/`, `Dialogs/` and `Scripts/` directories (Basic, dialog and Python, BeanShell and JavaScript macro
 *    libraries) and their entries in `META-INF/manifest.xml`. The event bindings of the document that name a macro are left, and
 *    dangle.
 *
 * Nothing is rewritten for a package that holds none of these, so the common case costs the read of the content types and of the
 * relationships parts.
 */

const CONTENT_TYPES_PART = '[Content_Types].xml';
const ODF_MANIFEST_PART = 'META-INF/manifest.xml';
const ODF_MIMETYPE_PART = 'mimetype';
const ODF_MACRO_DIRECTORIES = ['Basic/', 'Dialogs/', 'Scripts/'];
const OOXML_MACRO_CONTENT_TYPE = /^application\/vnd\.ms-(office\.vba|word\.vbaData)/i;
const OOXML_MACRO_PART_NAME = /(^|\/)(vbaProject(Signature)?\.bin|vbaData\.xml)$/i;
const OOXML_MACRO_RELATIONSHIP_TYPE = /\/(vbaProject|vbaProjectSignature|wordVbaData)$/i;
const XML_ELEMENT = /<(Override|Default|Relationship|manifest:file-entry)\b[^>]*?\/>/g;
/** The content types of the main parts of the macro-enabled formats, and the plain content types they are opened as. */
const MACRO_ENABLED_MAIN_TYPES: ReadonlyArray<readonly [string, string]> = [
  ['application/vnd.ms-word.document.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  ['application/vnd.ms-word.template.macroEnabledTemplate.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'],
  ['application/vnd.ms-excel.sheet.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  ['application/vnd.ms-excel.template.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'],
  ['application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
  ['application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'],
  ['application/vnd.ms-powerpoint.template.macroEnabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
];

export interface MacroStripResult {
  /** The input itself when it needed no change; otherwise the rewritten package. */
  buffer: Buffer;
  /** Whether a macro part was found and removed. */
  droppedMacros: boolean;
}

function attribute(element: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(element)?.[1];
}

/** The part names of `zip` that are not directories. */
function partNames(zip: JSZip): string[] {
  return Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
}

/** The part a relationship of `relationshipsPart` targets, as a package name (the rels part sits in `_rels/` beside its source). */
function targetOf(relationshipsPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const source = relationshipsPart.replace(/(^|\/)_rels\/[^/]*$/, '$1');
  const segments = `${source}${target}`.split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '..') resolved.pop();
    else if (segment !== '.' && segment !== '') resolved.push(segment);
  }
  return resolved.join('/');
}

/** What was done to a package: nothing, its macro-enabled main content type made the plain one (no macro part), or its macro parts removed. */
type StripOutcome = 'unchanged' | 'retyped' | 'dropped';

async function stripOoxmlMacros(zip: JSZip, budget: InflateBudget): Promise<StripOutcome> {
  const typesEntry = zip.file(CONTENT_TYPES_PART);
  if (!typesEntry) return 'unchanged';
  const types = await readZipEntryText(typesEntry, { budget });
  const macroParts = new Set<string>(partNames(zip).filter((name) => OOXML_MACRO_PART_NAME.test(name)));
  for (const element of types.match(XML_ELEMENT) ?? []) {
    const contentType = attribute(element, 'ContentType');
    const partName = attribute(element, 'PartName');
    if (contentType !== undefined && partName !== undefined && OOXML_MACRO_CONTENT_TYPE.test(contentType)) macroParts.add(partName.replace(/^\//, ''));
  }
  const macroDefaults = new Set<string>();
  for (const element of types.match(XML_ELEMENT) ?? []) {
    const contentType = attribute(element, 'ContentType');
    const extension = attribute(element, 'Extension');
    if (contentType !== undefined && extension !== undefined && OOXML_MACRO_CONTENT_TYPE.test(contentType)) {
      for (const name of partNames(zip)) if (name.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) macroParts.add(name);
      macroDefaults.add(extension.toLowerCase());
    }
  }
  const enabledMain = MACRO_ENABLED_MAIN_TYPES.find(([macroEnabled]) => types.includes(macroEnabled));
  // A package with a VBA project part named by relationship only is found below, by the relationships of its parts.
  const relationshipParts = partNames(zip).filter((name) => name.endsWith('.rels'));
  const rewrittenRelationships = new Map<string, string>();
  for (const name of relationshipParts) {
    const text = await readZipEntryText(zip.file(name)!, { budget });
    const kept = text.replace(XML_ELEMENT, (element) => {
      const type = attribute(element, 'Type');
      const target = attribute(element, 'Target');
      if (type === undefined || target === undefined) return element;
      const resolved = targetOf(name, target);
      if (OOXML_MACRO_RELATIONSHIP_TYPE.test(type) || macroParts.has(resolved)) {
        macroParts.add(resolved);
        return '';
      }
      return element;
    });
    if (kept !== text) rewrittenRelationships.set(name, kept);
  }
  if (macroParts.size === 0 && enabledMain === undefined) return 'unchanged';

  const rewrittenTypes = types.replace(XML_ELEMENT, (element) => {
    const contentType = attribute(element, 'ContentType');
    const partName = attribute(element, 'PartName');
    const extension = attribute(element, 'Extension');
    if (contentType === undefined) return element;
    if (OOXML_MACRO_CONTENT_TYPE.test(contentType)) return '';
    if (partName !== undefined && macroParts.has(partName.replace(/^\//, ''))) return '';
    if (extension !== undefined && macroDefaults.has(extension.toLowerCase())) return '';
    const plain = MACRO_ENABLED_MAIN_TYPES.find(([macroEnabled]) => macroEnabled === contentType)?.[1];
    return plain === undefined ? element : element.replace(contentType, plain);
  });
  zip.file(CONTENT_TYPES_PART, rewrittenTypes);
  for (const [name, text] of rewrittenRelationships) zip.file(name, text);
  for (const name of macroParts) zip.remove(name);
  return macroParts.size > 0 ? 'dropped' : 'retyped';
}

async function stripOpenDocumentMacros(zip: JSZip, budget: InflateBudget): Promise<StripOutcome> {
  const manifestEntry = zip.file(ODF_MANIFEST_PART);
  if (!manifestEntry || !zip.file(ODF_MIMETYPE_PART)) return 'unchanged';
  const macroParts = partNames(zip).filter((name) => ODF_MACRO_DIRECTORIES.some((directory) => name.startsWith(directory)));
  if (macroParts.length === 0) return 'unchanged';
  const manifest = (await readZipEntryText(manifestEntry, { budget })).replace(XML_ELEMENT, (element) => {
    const fullPath = attribute(element, 'manifest:full-path');
    return fullPath !== undefined && ODF_MACRO_DIRECTORIES.some((directory) => fullPath.startsWith(directory)) ? '' : element;
  });
  zip.file(ODF_MANIFEST_PART, manifest);
  for (const name of macroParts) zip.remove(name);
  for (const directory of ODF_MACRO_DIRECTORIES) zip.remove(directory);
  // The first entry of an OpenDocument package is its mimetype, stored: a reader finds the type by the bytes after the header.
  zip.file(ODF_MIMETYPE_PART, await zip.file(ODF_MIMETYPE_PART)!.async('nodebuffer'), { compression: 'STORE' });
  return 'dropped';
}

/**
 * `buffer` without the macros it holds, or `buffer` itself when it is no package or holds none. A package the ZIP reader cannot open is
 * returned as it is: the office suite refuses it, and says so.
 */
export async function stripOfficeMacros(buffer: Buffer): Promise<MacroStripResult> {
  const unchanged: MacroStripResult = { buffer, droppedMacros: false };
  if (!startsWithBytes(buffer, ZIP_LOCAL_HEADER_SIGNATURE)) return unchanged;
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return unchanged;
  }
  const budget = new InflateBudget();
  let outcome = await stripOoxmlMacros(zip, budget);
  if (outcome === 'unchanged') outcome = await stripOpenDocumentMacros(zip, budget);
  if (outcome === 'unchanged') return unchanged;
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), droppedMacros: outcome === 'dropped' };
}
