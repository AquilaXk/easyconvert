import { PDFDict, PDFDocument, PDFPage } from 'pdf-lib';
import type { PDFContext, PDFRef } from 'pdf-lib';
import { DestinationMerge, resolveLinkDestinations, SourceDestinations } from './pdf-merge-destinations';
import { analyzeInputForms, FormMerge } from './pdf-merge-forms';
import { PdfObjectCopier } from './pdf-merge-object-copier';
import { dictAt, name, refsOf } from './pdf-merge-objects';
import { OutlineMerge } from './pdf-merge-outlines';
import { PageLabelMerge } from './pdf-merge-page-labels';

/** The title of the top-level bookmark of an input: its file name without the extension of a PDF. */
export function bookmarkTitle(fileName: string | undefined): string | undefined {
  const title = fileName?.replace(/\.pdf$/i, '').trim();
  return title ? title : undefined;
}

/**
 * Copies the pages of `source` into `destination` with one copier and gives them their places in the output. The pages are the copier's
 * first objects: a reference to a page that a widget (`/P`), a link or a bookmark holds is copied as a reference to the copied page, where
 * `PDFDocument.copyPages` would copy that page again as an object no page tree reaches.
 */
function copyPagesOf(source: PDFDocument, destination: PDFDocument, copier: PdfObjectCopier): PDFPage[] {
  const sourcePages = source.getPages();
  const refs = sourcePages.map((page) => {
    const ref = destination.context.nextRef();
    copier.map(page.ref, ref);
    return ref;
  });
  return sourcePages.map((page, index) => {
    const copy = copier.copy(page.node);
    destination.context.assign(refs[index], copy);
    return PDFPage.of(copy, refs[index], destination);
  });
}

/**
 * The pages of a copied input point at a structure tree that the merge does not carry over: a /StructParents on a page or a /StructParent
 * on an annotation would name an entry of a parent tree the output does not have.
 */
function dropStructureParents(context: PDFContext, pages: PDFPage[]): void {
  for (const page of pages) {
    page.node.delete(name('StructParents'));
    for (const annotation of refsOf(page.node.Annots())) dictAt(context, annotation)?.delete(name('StructParent'));
  }
}

/** The entries of the document information of the first input that the output keeps: all but the producer and the date of change. */
const INFO_ENTRIES_LEFT_TO_THE_WRITER = new Set(['Producer', 'ModDate']);

function copyDocumentInformation(source: PDFDocument, destination: PDFDocument, copier: PdfObjectCopier): void {
  const info = dictAt(source.context, source.context.trailerInfo.Info);
  const target = dictAt(destination.context, destination.context.trailerInfo.Info);
  if (!info || !target) return;
  for (const [key, value] of info.entries()) {
    if (!INFO_ENTRIES_LEFT_TO_THE_WRITER.has(key.decodeText())) target.set(key, copier.copy(value));
  }
}

/**
 * A merge of PDF documents into one: the pages in the order the inputs come, with what lives outside the pages carried over (form fields,
 * bookmarks, links and named destinations, page labels, the document information of the first input).
 */
export class PdfMerge {
  private readonly forms: FormMerge;
  private readonly destinations = new DestinationMerge();
  private readonly outline: OutlineMerge;
  private readonly labels = new PageLabelMerge();
  private inputs = 0;

  private constructor(readonly destination: PDFDocument) {
    this.forms = new FormMerge(destination);
    this.outline = new OutlineMerge(destination.context);
  }

  static async create(): Promise<PdfMerge> {
    return new PdfMerge(await PDFDocument.create());
  }

  /** Adds the pages of `source`, a document no other merge reads from now on; `fileName` names its bookmark. */
  append(source: PDFDocument, fileName?: string): void {
    const { destination } = this;
    // The index of the fields corrects a wrong /Parent of the source, which has to be done before the fields are copied.
    const forms = analyzeInputForms(source);
    const copier = PdfObjectCopier.for(source.context, destination.context);
    const sourcePages = source.getPages();
    const pages = copyPagesOf(source, destination, copier);
    const pageTags = new Set(sourcePages.map((page) => page.ref.tag));
    const names = new SourceDestinations(source.context, source.catalog);
    dropStructureParents(destination.context, pages);
    resolveLinkDestinations(destination.context, pages, names, copier);
    if (forms) this.forms.merge(forms, copier, sourcePages, pages);
    this.destinations.add(names, copier, pageTags);
    const firstPage: PDFRef | undefined = pages[0]?.ref;
    this.outline.appendInput({ source, copier, pageTags, names, firstPage, title: bookmarkTitle(fileName) });
    this.labels.addInput(source);
    if (this.inputs === 0) copyDocumentInformation(source, destination, copier);
    for (const page of pages) destination.addPage(page);
    this.inputs += 1;
  }

  /** The merged document, with the bookmarks, the named destinations and the page labels of all the inputs written. */
  finish(): PDFDocument {
    const { destination } = this;
    const catalog: PDFDict = destination.catalog;
    this.outline.finish(catalog);
    this.destinations.finish(destination.context, catalog);
    this.labels.finish(destination.context, catalog);
    return destination;
  }
}
