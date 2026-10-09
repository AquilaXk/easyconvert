import type JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { decodeXmlBytes, openPackage, readPackageEntry, resolvePackagePath } from './package-access';
import { childElements, firstChild, ownText, parseXmlTree, type XmlElement } from './xml-tree';

/**
 * Opens an EPUB package (EPUB Packages 3.3 and Open Packaging Format 2.0.1): META-INF/container.xml names the package
 * document, whose metadata, manifest and spine say what the book is and in which order its content documents read.
 * A package that is not well-formed, names parts it does not hold, lists more content documents than the limit or
 * hides its content behind encryption (other than font obfuscation) is refused with a typed error.
 */

/** The most spine items, the largest decoded chapter and the most text one book may hold. */
export const EPUB_MAX_SPINE_ITEMS = 10_000;
export const EPUB_MAX_CHAPTER_BYTES = 32 * 1024 * 1024;
export const EPUB_MAX_TEXT_CHARS = 128 * 1024 * 1024;
const EPUB_CONTAINER_PATH = 'META-INF/container.xml';
const EPUB_ENCRYPTION_PATH = 'META-INF/encryption.xml';
const EPUB_PACKAGE_MEDIA_TYPE = 'application/oebps-package+xml';
/** Most manifest items read: a spine of EPUB_MAX_SPINE_ITEMS documents plus their images and styles. */
const EPUB_MAX_MANIFEST_ITEMS = EPUB_MAX_SPINE_ITEMS * 8;
/** Spine items that hold readable text: XHTML content documents (EPUB 2 and 3) and HTML. */
export const EPUB_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set(['application/xhtml+xml', 'text/html']);
// Algorithm identifiers from the EPUB OCF specification: namespace names compared as strings, never fetched.
const EPUB_FONT_OBFUSCATION_ALGORITHMS: ReadonlySet<string> = new Set([
  'http://www.idpf.org/2008/embedding', // NOSONAR: a spec-defined identifier, not a network address
  'http://ns.adobe.com/pdf/enc#RC', // NOSONAR: a spec-defined identifier, not a network address
]);

export interface EpubItem {
  readonly id: string;
  /** Package path of the item. */
  readonly path: string;
  readonly mediaType: string;
  readonly properties: readonly string[];
}

export interface EpubSpineItem extends EpubItem {
  readonly encrypted: boolean;
}

export interface EpubPackage {
  readonly title?: string;
  readonly creators: readonly string[];
  readonly language?: string;
  readonly spine: readonly EpubSpineItem[];
  /** Every manifest item by package path. */
  readonly items: ReadonlyMap<string, EpubItem>;
  /** Reads a part of the package as bytes under the chapter size limit. */
  read(path: string, what: string): Promise<Buffer>;
}

async function encryptedPaths(zip: JSZip): Promise<Set<string>> {
  const encrypted = new Set<string>();
  const file = zip.file(EPUB_ENCRYPTION_PATH);
  if (!file) return encrypted;
  const root = parseXmlTree(decodeXmlBytes(await file.async('nodebuffer'), 'EPUB encryption.xml'), EPUB_ENCRYPTION_PATH, 'EPUB');
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    if (element.local === 'EncryptedData') {
      const algorithm = firstChild(element, 'EncryptionMethod')?.attrs.get('Algorithm');
      const reference = firstChild(element, 'CipherData');
      const uri = (reference ? firstChild(reference, 'CipherReference') : undefined)?.attrs.get('URI');
      if (uri !== undefined && !EPUB_FONT_OBFUSCATION_ALGORITHMS.has(algorithm ?? '')) encrypted.add(resolvePackagePath('', uri));
    }
    for (const child of element.children) if (typeof child !== 'string') stack.push(child);
  }
  return encrypted;
}

function text(element: XmlElement | undefined): string | undefined {
  const value = element ? ownText(element).trim() : '';
  return value === '' ? undefined : value;
}

export async function openEpubPackage(input: Buffer): Promise<EpubPackage> {
  const zip = await openPackage(input, 'EPUB');
  const container = zip.file(EPUB_CONTAINER_PATH);
  if (!container) throw new ConversionFailedError(`The EPUB has no ${EPUB_CONTAINER_PATH}, so its package document cannot be found.`);
  const containerRoot = parseXmlTree(decodeXmlBytes(await container.async('nodebuffer'), 'EPUB container.xml'), EPUB_CONTAINER_PATH, 'EPUB');
  const rootfiles = firstChild(containerRoot, 'rootfiles');
  const rootfile = (rootfiles ? childElements(rootfiles, 'rootfile') : []).find(
    (el) => el.attrs.get('full-path') && (el.attrs.get('media-type') ?? EPUB_PACKAGE_MEDIA_TYPE) === EPUB_PACKAGE_MEDIA_TYPE
  );
  if (!rootfile) throw new ConversionFailedError(`${EPUB_CONTAINER_PATH} names no package document.`);
  const packagePath = resolvePackagePath('', rootfile.attrs.get('full-path') as string);
  const packageDirectory = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';
  const packageRoot = parseXmlTree(
    decodeXmlBytes(await readPackageEntry(zip, packagePath, EPUB_MAX_CHAPTER_BYTES, 'EPUB container.xml'), 'EPUB package document'),
    packagePath,
    'EPUB'
  );

  const manifestElement = firstChild(packageRoot, 'manifest');
  const manifestItems = manifestElement ? childElements(manifestElement, 'item') : [];
  if (manifestItems.length > EPUB_MAX_MANIFEST_ITEMS) {
    throw new PayloadLimitError(`The EPUB manifest lists more than ${EPUB_MAX_MANIFEST_ITEMS} items.`);
  }
  const manifest = new Map<string, EpubItem>();
  const items = new Map<string, EpubItem>();
  for (const item of manifestItems) {
    const id = item.attrs.get('id');
    const href = item.attrs.get('href');
    if (!id || !href) continue;
    const entry: EpubItem = {
      id,
      path: resolvePackagePath(packageDirectory, href),
      mediaType: item.attrs.get('media-type') ?? '',
      properties: (item.attrs.get('properties') ?? '').split(/\s+/).filter(Boolean),
    };
    manifest.set(id, entry);
    items.set(entry.path, entry);
  }

  const spineElement = firstChild(packageRoot, 'spine');
  const itemrefs = spineElement ? childElements(spineElement, 'itemref') : [];
  if (itemrefs.length === 0) throw new ConversionFailedError('The EPUB package document has an empty spine.');
  if (itemrefs.length > EPUB_MAX_SPINE_ITEMS) {
    throw new PayloadLimitError(`The EPUB spine lists more than ${EPUB_MAX_SPINE_ITEMS} content documents.`);
  }
  const encrypted = await encryptedPaths(zip);
  const spine: EpubSpineItem[] = itemrefs.map((itemref) => {
    const idref = itemref.attrs.get('idref') ?? '';
    const item = manifest.get(idref);
    if (!item) throw new ConversionFailedError(`The EPUB spine names "${idref}", which the manifest does not list.`);
    return { ...item, encrypted: encrypted.has(item.path) };
  });

  const metadata = firstChild(packageRoot, 'metadata');
  return {
    title: text(metadata ? firstChild(metadata, 'title') : undefined),
    creators: (metadata ? childElements(metadata, 'creator') : []).map((creator) => text(creator)).filter((name): name is string => name !== undefined),
    language: text(metadata ? firstChild(metadata, 'language') : undefined),
    spine,
    items,
    read: (path, what) => readPackageEntry(zip, path, EPUB_MAX_CHAPTER_BYTES, what),
  };
}
