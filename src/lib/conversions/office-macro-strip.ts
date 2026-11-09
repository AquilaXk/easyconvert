import JSZip from 'jszip';
import { InflateBudget } from './bounded-inflate';
import { startsWithBytes, ZIP_LOCAL_HEADER_SIGNATURE } from './package-access';
import { newRelationshipAllowance, forEachRelationship } from './office/opc-parts';
import { resolveZipPath } from './office/zip-path';
import { safeExtractXmlElements, type SafeXmlElement } from './safe-xml-scanner';
import { readZipEntryBytes, readZipEntryText } from './zip-entry-reader';
import { ConversionFailedError } from '../types';

/**
 * Removes the macros of an Office Open XML or OpenDocument package by what the package holds, not by what it is called. A `.docx` that
 * carries a `vbaProject.bin` (a macro-enabled document renamed) or an `.odt` with a Basic library is as dangerous as the `.docm` or the
 * `.odm` the format names say, so the check is made on every package the office suite is handed.
 *
 *  - Office Open XML: the parts whose content type is a VBA project (`application/vnd.ms-office.vbaProject`, its signature, the Word
 *    `vbaData`) or an Excel 4.0 macro sheet (`macrosheet`, `intlmacrosheet`) or whose name is `vbaProject.bin`, `vbaProjectSignature.bin`
 *    or `vbaData.xml`; the relationships that point at them in any part; their entries in `[Content_Types].xml`; the `sheet` of
 *    `xl/workbook.xml` that a removed macro sheet was (and the sheet indexes the defined names use); and the macro-enabled content type of the
 *    main part, which becomes the plain one so that the package is the plain format the office suite opens.
 *  - OpenDocument (a package with a `META-INF/manifest.xml`, whether or not it has a `mimetype` entry): the `Basic/`, `Dialogs/` and `Scripts/`
 *    directories (Basic, dialog and Python, BeanShell and JavaScript macro libraries) of the package and of its embedded objects and
 *    sub-documents (`Object 1/Basic/`, `subdoc/Basic/`), and their entries in `META-INF/manifest.xml`. The event bindings of the
 *    document that name a macro are left, and dangle.
 *
 * The content types and the relationships are read with the scanner the Office readers share (linear time, quotes and attribute order as
 * XML has them, an element written open and closed as well as self-closing). Every pass over the entries or over the elements is a single
 * pass, and a package with more entries or elements than the limits below is refused: this runs on the worker's thread before the office
 * suite starts, so its cost must not depend on how the package is built.
 *
 * Nothing is rewritten for a package that holds none of these, so the common case costs the read of the content types and of the
 * relationships parts.
 */

const CONTENT_TYPES_PART = '[Content_Types].xml';
const ODF_MANIFEST_PART = /(^|\/)META-INF\/manifest\.xml$/i;
const ODF_MIMETYPE_PART = 'mimetype';
const ODF_MANIFEST_ROOT = 'META-INF/manifest.xml';
/** A macro library directory of an OpenDocument package, at its root or in an embedded object or sub-document (`Object 1/Basic/`, `subdoc/Basic/`). */
const ODF_MACRO_PATH = /(^|\/)(Basic|Dialogs|Scripts)(\/|$)/i;
const OOXML_MACRO_CONTENT_TYPE = /^application\/vnd\.ms-(office\.vba|word\.vbaData|excel\.(intl)?macrosheet)/i;
const OOXML_MACRO_PART_NAME = /(^|\/)(vbaProject(Signature)?\.bin|vbaData\.xml)$/i;
const OOXML_MACRO_RELATIONSHIP_TYPE = /\/(vbaProject|vbaProjectSignature|wordVbaData|xlMacrosheet|xlIntlMacrosheet)$/i;
/** Most entries a package may hold for this check, and most elements a content types part may list (a document holds hundreds). */
export const MACRO_STRIP_MAX_ENTRIES = 100_000;
export const MACRO_STRIP_MAX_TYPE_ELEMENTS = 100_000;
/** The content types of the main parts of the macro-enabled formats (lowercased for case-insensitive lookup), and the plain content types they are opened as. */
const MACRO_ENABLED_MAIN_TYPES: ReadonlyMap<string, string> = new Map([
  ['application/vnd.ms-word.document.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  ['application/vnd.ms-word.template.macroenabledtemplate.main+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'],
  ['application/vnd.ms-excel.sheet.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  ['application/vnd.ms-excel.template.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml'],
  ['application/vnd.ms-powerpoint.presentation.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
  ['application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml'],
  ['application/vnd.ms-powerpoint.template.macroenabled.main+xml', 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml'],
]);

export interface MacroStripResult {
  /** The input itself when it needed no change; otherwise the rewritten package. */
  buffer: Buffer;
  /** Whether a macro part was found and removed. */
  droppedMacros: boolean;
}

/** A change to a text: the characters from `start` to `end` become `replacement`. */
interface Edit {
  start: number;
  end: number;
  replacement: string;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = '';
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, edit.start) + edit.replacement;
    at = edit.end;
  }
  return out + text.slice(at);
}

/** The part names of `zip` that are not directories, listed once. */
function partNames(zip: JSZip): string[] {
  const names: string[] = [];
  for (const entry of Object.values(zip.files)) if (!entry.dir) names.push(entry.name);
  return names;
}

/** Finds a non-directory entry in `zip` matching `path` case-insensitively (ECMA-376 Part 2 §6.2.2.4). */
function findEntry(zip: JSZip, path: string): JSZip.JSZipObject | null {
  const exact = zip.file(path);
  if (exact) return exact;
  const lower = path.toLowerCase();
  for (const entry of Object.values(zip.files)) {
    if (!entry.dir && entry.name.toLowerCase() === lower) return entry;
  }
  return null;
}

function refuseTooMany(what: string, count: number, limit: number): never {
  throw new ConversionFailedError(`The package lists ${count} ${what}, more than the ${limit} an office file may.`);
}

function assertEntryCount(zip: JSZip): void {
  const count = Object.keys(zip.files).length;
  if (count > MACRO_STRIP_MAX_ENTRIES) refuseTooMany('entries', count, MACRO_STRIP_MAX_ENTRIES);
}

/** The elements of `xml` named `tagName`, refusing a part that lists more than `limit`. */
function elementsWithin(xml: string, tagName: string | string[], limit: number, what: string): SafeXmlElement[] {
  const found = safeExtractXmlElements(xml, tagName, { maxElements: limit + 1 });
  if (found.length > limit) refuseTooMany(what, found.length, limit);
  return found;
}

/** The directory of the part a relationships part belongs to: `word/_rels/document.xml.rels` belongs to `word/document.xml`. */
function sourceOf(relationshipsPart: string): string {
  return relationshipsPart.replace(/(^|\/)_rels\/(.*)\.rels$/i, '$1$2');
}

/** What was done to a package: nothing, its macro-enabled main content type made the plain one (no macro part), or its macro parts removed. */
type StripOutcome = 'unchanged' | 'retyped' | 'dropped';

/** The macro parts that the content types name (by `Override`, and by `Default` extension) and those whose name says so, in one pass over the entries (lowercased). */
function macroPartsOf(typeElements: readonly SafeXmlElement[], names: readonly string[]): Set<string> {
  const macroParts = new Set<string>();
  const macroExtensions = new Set<string>();
  for (const element of typeElements) {
    const { ContentType: contentType, PartName: partName, Extension: extension } = element.attrs;
    if (contentType === undefined || !OOXML_MACRO_CONTENT_TYPE.test(contentType)) continue;
    if (partName !== undefined) macroParts.add(partName.replace(/^\//, '').toLowerCase());
    if (extension !== undefined) macroExtensions.add(extension.toLowerCase());
  }
  for (const name of names) {
    const dot = name.lastIndexOf('.');
    if (OOXML_MACRO_PART_NAME.test(name) || (dot >= 0 && macroExtensions.has(name.slice(dot + 1).toLowerCase()))) macroParts.add(name.toLowerCase());
  }
  return macroParts;
}

interface RelationshipsRewrite {
  text: string;
  /** Ids of the relationships of this part that were removed. */
  removedIds: string[];
}

/** `xml` of a relationships part without the relationships to macro parts, which join `macroParts`; undefined when it keeps all of them. */
function withoutMacroRelationships(relationshipsPart: string, xml: string, macroParts: Set<string>, allowance: ReturnType<typeof newRelationshipAllowance>): RelationshipsRewrite | undefined {
  const directory = sourceOf(relationshipsPart).replace(/\/?[^/]*$/, '');
  const edits: Edit[] = [];
  const removedIds: string[] = [];
  forEachRelationship(xml, allowance, (relationship) => {
    const { Type: type, Target: target, TargetMode: mode, Id: id } = relationship.attrs;
    if (type === undefined || target === undefined) return;
    const resolved = mode === 'External' ? undefined : resolveZipPath(directory, target)?.toLowerCase();
    if (!OOXML_MACRO_RELATIONSHIP_TYPE.test(type) && !(resolved !== undefined && macroParts.has(resolved))) return;
    if (resolved !== undefined) macroParts.add(resolved);
    if (id !== undefined) removedIds.push(id);
    edits.push({ start: relationship.startIndex, end: relationship.endIndex, replacement: '' });
  });
  return edits.length === 0 ? undefined : { text: applyEdits(xml, edits), removedIds };
}

/** The Ids of the sheets of `xl/workbook.xml` that were macro sheets, taken out of it, with the defined names that were bound to them or to a sheet after them fixed. */
function withoutRemovedSheets(workbook: string, removedIds: ReadonlySet<string>): string {
  const sheets = elementsWithin(workbook, 'sheet', MACRO_STRIP_MAX_TYPE_ELEMENTS, 'sheets');
  const removedIndexes = new Set<number>();
  const edits: Edit[] = [];
  sheets.forEach((sheet, index) => {
    const id = sheet.attrs['r:id'] ?? sheet.attrs.id;
    if (id !== undefined && removedIds.has(id)) {
      removedIndexes.add(index);
      edits.push({ start: sheet.startIndex, end: sheet.endIndex, replacement: '' });
    }
  });
  if (removedIndexes.size === 0) return workbook;
  for (const name of elementsWithin(workbook, 'definedName', MACRO_STRIP_MAX_TYPE_ELEMENTS, 'defined names')) {
    const scope = name.attrs.localSheetId;
    if (scope === undefined) continue;
    const index = Number(scope);
    if (removedIndexes.has(index)) {
      edits.push({ start: name.startIndex, end: name.endIndex, replacement: '' });
      continue;
    }
    const before = [...removedIndexes].filter((removed) => removed < index).length;
    if (before > 0) edits.push({ start: name.startIndex, end: name.endIndex, replacement: name.raw.replace(/localSheetId\s*=\s*(["'])\d+\1/, `localSheetId="${index - before}"`) });
  }
  return applyEdits(workbook, edits);
}

async function stripOoxmlMacros(zip: JSZip, budget: InflateBudget): Promise<StripOutcome> {
  const typesEntry = findEntry(zip, CONTENT_TYPES_PART);
  if (!typesEntry) return 'unchanged';
  assertEntryCount(zip);
  const names = partNames(zip);
  const types = await readZipEntryText(typesEntry, { budget });
  const typeElements = elementsWithin(types, ['Default', 'Override'], MACRO_STRIP_MAX_TYPE_ELEMENTS, 'content types');
  const macroParts = macroPartsOf(typeElements, names);
  const enabledMain = typeElements.some((element) => MACRO_ENABLED_MAIN_TYPES.has((element.attrs.ContentType ?? '').toLowerCase()));

  // Relationships to a macro part, by their type or by their target, in any part. A target found through a relationship of a macro type is a
  // macro part for every relationship, so the parts are read twice: the first round collects the targets, the second one rewrites.
  const relationshipParts = names.filter((name) => /\.rels$/i.test(name));
  for (const name of relationshipParts) {
    withoutMacroRelationships(name, await readZipEntryText(zip.file(name)!, { budget }), macroParts, newRelationshipAllowance());
  }
  const allowance = newRelationshipAllowance();
  const rewritten = new Map<string, string>();
  const removedByPart = new Map<string, string[]>();
  for (const name of relationshipParts) {
    const result = withoutMacroRelationships(name, await readZipEntryText(zip.file(name)!, { budget }), macroParts, allowance);
    if (result) {
      rewritten.set(name, result.text);
      removedByPart.set(sourceOf(name), result.removedIds);
    }
  }
  if (macroParts.size === 0 && !enabledMain) return 'unchanged';

  const edits: Edit[] = [];
  for (const element of typeElements) {
    const { ContentType: contentType, PartName: partName, Extension: extension } = element.attrs;
    if (contentType === undefined) continue;
    const macroDefault = extension !== undefined && OOXML_MACRO_CONTENT_TYPE.test(contentType);
    if (OOXML_MACRO_CONTENT_TYPE.test(contentType) || macroDefault || (partName !== undefined && macroParts.has(partName.replace(/^\//, '').toLowerCase()))) {
      edits.push({ start: element.startIndex, end: element.endIndex, replacement: '' });
      continue;
    }
    const plain = MACRO_ENABLED_MAIN_TYPES.get(contentType.toLowerCase());
    if (plain !== undefined) edits.push({ start: element.startIndex, end: element.endIndex, replacement: element.raw.replace(contentType, plain) });
  }
  zip.file(typesEntry.name, applyEdits(types, edits));
  for (const [name, text] of rewritten) zip.file(name, text);
  for (const [source, ids] of removedByPart) {
    const part = findEntry(zip, source);
    if (part && /(^|\/)workbook\.xml$/i.test(source) && ids.length > 0) {
      zip.file(part.name, withoutRemovedSheets(await readZipEntryText(part, { budget }), new Set(ids)));
    }
  }
  for (const name of names) {
    if (macroParts.has(name.toLowerCase())) zip.remove(name);
  }
  // The relationships of a removed part go with it.
  for (const name of relationshipParts) if (macroParts.has(sourceOf(name).toLowerCase())) zip.remove(name);
  return macroParts.size > 0 ? 'dropped' : 'retyped';
}

async function stripOpenDocumentMacros(zip: JSZip, budget: InflateBudget): Promise<StripOutcome> {
  // The manifest is what makes a package an OpenDocument one for the office suite, which loads a package without a `mimetype` entry as well.
  if (!findEntry(zip, ODF_MANIFEST_ROOT)) return 'unchanged';
  assertEntryCount(zip);
  const macroEntries: string[] = [];
  const manifests: string[] = [];
  for (const entry of Object.values(zip.files)) {
    if (ODF_MACRO_PATH.test(entry.name)) macroEntries.push(entry.name);
    else if (!entry.dir && ODF_MANIFEST_PART.test(entry.name)) manifests.push(entry.name);
  }
  if (macroEntries.length === 0) return 'unchanged';
  for (const name of manifests) {
    const text = await readZipEntryText(zip.file(name)!, { budget });
    const prefix = name.replace(/META-INF\/manifest\.xml$/i, '');
    const edits = elementsWithin(text, 'file-entry', MACRO_STRIP_MAX_TYPE_ELEMENTS, 'manifest entries')
      .filter((entry) => ODF_MACRO_PATH.test(`${prefix}${entry.attrs['manifest:full-path'] ?? ''}`.replace(/^\//, '')))
      .map((entry): Edit => ({ start: entry.startIndex, end: entry.endIndex, replacement: '' }));
    if (edits.length > 0) zip.file(name, applyEdits(text, edits));
  }
  for (const name of macroEntries) zip.remove(name);
  // The first entry of an OpenDocument package is its mimetype, stored: a reader finds the type by the bytes after the header.
  const mimetype = findEntry(zip, ODF_MIMETYPE_PART);
  if (mimetype) zip.file(mimetype.name, await readZipEntryBytes(mimetype, { budget }), { compression: 'STORE' });
  return 'dropped';
}

/**
 * `buffer` without the macros it holds, or `buffer` itself when it is no package or holds none. A package the ZIP reader cannot open is
 * returned as it is: the office suite refuses it, and says so. A package with more entries or elements than the limits is refused
 * (a typed 400 error).
 */
/** The outcome that says more: a dropped part over a retyped package over no change. */
function strongerOutcome(a: StripOutcome, b: StripOutcome): StripOutcome {
  const rank: Record<StripOutcome, number> = { unchanged: 0, retyped: 1, dropped: 2 };
  return rank[a] >= rank[b] ? a : b;
}

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
  // Both passes run: a package can carry the parts of both (a polyglot), and the second pass must not be skipped because the first found something.
  const ooxml = await stripOoxmlMacros(zip, budget);
  const odf = await stripOpenDocumentMacros(zip, budget);
  const outcome = strongerOutcome(ooxml, odf);
  if (outcome === 'unchanged') return unchanged;
  return { buffer: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), droppedMacros: outcome === 'dropped' };
}
