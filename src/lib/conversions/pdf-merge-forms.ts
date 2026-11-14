/*
 * The form fields of the inputs of a merge, translated from qpdf (https://github.com/qpdf/qpdf), tag v12.4.2, commit
 * 4eba95899886e851cc41d76886483b347612f2a8 (Apache-2.0, Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger), file libqpdf/QPDFAcroFormDocumentHelper.cc
 * (SHA-256 845ce9f3...f03ee3): `AcroForm::transformAnnotations` (the part for annotations copied from another document, without a
 * transformation matrix), `AcroForm::fixCopiedAnnotations`, `AcroForm::adjustInheritedFields`, `AcroForm::adjustDefaultAppearances` and
 * `AcroForm::adjustAppearanceStream`, with the page loop of `QPDFJob::handlePageSpecs` (libqpdf/QPDFJob.cc, SHA-256 beab92b2...2ff2c8) that
 * calls `fixCopiedAnnotations` for the pages of every input but the first.
 *
 * What the translation keeps: the algorithm and its order of steps (merge the /DR of the input into the /DR of the document and record the
 * resources that had to be renamed, copy a /DA or /Q that a field took from the /AcroForm of its own input, rewrite the /DA of the fields and
 * the content of their appearance streams for the renamed resources, rename the fields whose name the document has, add them to /Fields), the
 * names in camelCase and the comments. What differs is the object model, and the copy: qpdf copies an annotation again after copying it from
 * the other file, because it may copy one page many times; here every input is copied once with one copier (pdf-merge-object-copier.ts), so
 * the fields are the copies already and the second copy is left out. qpdf also calls `fixCopiedAnnotations` once for each page, which splits a
 * field that has widgets on two pages into two fields; here the fields of all the pages of an input are collected first and added together.
 * Changes for this repository are in other files and other commits, each with its reason in its message.
 */
import { deflateSync } from 'node:zlib';
import { decodePDFRawStream, PDFBool, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString } from 'pdf-lib';
import type { PDFArray, PDFContext, PDFDocument, PDFPage } from 'pdf-lib';
import { findResourceNames, replaceResourceNames } from './pdf-merge-content-names';
import type { ResourceRenames } from './pdf-merge-content-names';
import { FormIndex } from './pdf-merge-form-index';
import type { PdfObjectCopier } from './pdf-merge-object-copier';
import { arrayAt, dictAt, name, numberAt, refsOf, stringFromBytes, textAt, textObject } from './pdf-merge-objects';
import { makeResourcesIndirect, mergeResources } from './pdf-merge-resources';

/** The /AcroForm of an input and the index of its fields, built before any of its objects is copied (the index corrects a wrong /Parent). */
export interface InputForms {
  context: PDFContext;
  acroForm: PDFDict;
  index: FormIndex;
}

/** The widget annotations that the pages of `pages` list. */
function widgetAnnotationsOf(context: PDFContext, pages: PDFPage[]): PDFRef[] {
  const widgets: PDFRef[] = [];
  for (const page of pages) {
    for (const annotation of refsOf(page.node.Annots())) {
      if (dictAt(context, annotation)?.get(name('Subtype')) === name('Widget')) widgets.push(annotation);
    }
  }
  return widgets;
}

/** `QPDFAcroFormDocumentHelper::validate`/`analyze` for an input; `undefined` when it has no /AcroForm (qpdf leaves its widgets alone). */
export function analyzeInputForms(source: PDFDocument): InputForms | undefined {
  const acroForm = dictAt(source.context, source.catalog.get(name('AcroForm')));
  if (!acroForm) return undefined;
  const index = new FormIndex(source.context);
  index.analyze(arrayAt(source.context, acroForm.get(name('Fields'))), widgetAnnotationsOf(source.context, source.getPages()));
  return { context: source.context, acroForm, index };
}

const encodeName = (resource: string): string => PDFName.of(resource).asString();

const copyRenames = (renames: ResourceRenames): ResourceRenames => new Map([...renames].map(([type, byName]) => [type, new Map(byName)]));

/** What `transformAnnotations` knows about the /AcroForm of the document and of the input while it copies the fields of the input. */
interface ForeignFormState {
  overrideDa: boolean;
  fromDefaultDa: string;
  overrideQ: boolean;
  fromDefaultQ: number;
  /** `dr_map`: resource renames, by type and name, that merging the /DR of the input into the one of the document made necessary. */
  renames: ResourceRenames;
  /** The /DR of the document once it has been set up (`init_dr_map`), the reference that a field's /DR becomes. */
  drRef?: PDFRef;
}

export class FormMerge {
  private readonly context: PDFContext;
  private readonly index: FormIndex;

  constructor(private readonly destination: PDFDocument) {
    this.context = destination.context;
    this.index = new FormIndex(destination.context);
  }

  private acroForm(): PDFDict | undefined {
    return dictAt(this.context, this.destination.catalog.get(name('AcroForm')));
  }

  /** The top-level field of each widget annotation of the pages of the input, as the copies in the document, in page order. */
  private topFieldsOf(input: InputForms, copier: PdfObjectCopier, sourcePages: PDFPage[]): PDFRef[] {
    const tops = new Map<string, PDFRef>();
    for (const page of sourcePages) {
      for (const annotation of refsOf(page.node.Annots())) {
        const field = input.index.fieldForAnnotation(annotation);
        if (!field) continue;
        const copy = copier.copy(input.index.rootField(field));
        tops.set(copy.tag, copy);
      }
    }
    return [...tops.values()];
  }

  /**
   * Adds the fields of the pages of `input`, which `copier` has copied to `destinationPages`, to the /AcroForm of the document. The input
   * that gives the document its /AcroForm brings its /DA, /Q, /DR and the rest of the dictionary along; the others are merged into it.
   */
  merge(input: InputForms, copier: PdfObjectCopier, sourcePages: PDFPage[], destinationPages: PDFPage[]): void {
    const tops = this.topFieldsOf(input, copier, sourcePages);
    if (tops.length === 0) return;
    const existing = this.acroForm();
    if (!existing) {
      const fields = this.createAcroForm(input, copier);
      for (const top of tops) this.index.addFormField(top, fields);
      return;
    }
    const state = this.foreignState(existing, input);
    for (const top of tops) this.traverseCopiedField(top, existing, input, copier, state);
    if (state.renames.size > 0) this.adjustAppearanceStreams(destinationPages, state.renames);
    this.mergeSignatureFlags(existing, input);
    this.mergeCalculationOrder(existing, input, copier);
    this.index.addAndRenameFormFields(tops, this.fieldsOf(existing));
  }

  private fieldsOf(acroForm: PDFDict): PDFArray {
    const fields = arrayAt(this.context, acroForm.get(name('Fields')));
    if (fields) return fields;
    const created = this.context.obj([]) as PDFArray;
    acroForm.set(name('Fields'), created);
    return created;
  }

  /** The /AcroForm of the first input that has fields: its entries, the fields excepted, and an XFA form, which a merge makes stale. */
  private createAcroForm(input: InputForms, copier: PdfObjectCopier): PDFArray {
    const acroForm = PDFDict.withContext(this.context);
    for (const [key, value] of input.acroForm.entries()) {
      if (key !== name('Fields') && key !== name('XFA')) acroForm.set(key, copier.copy(value));
    }
    const fields = this.context.obj([]) as PDFArray;
    acroForm.set(name('Fields'), fields);
    this.destination.catalog.set(name('AcroForm'), this.context.register(acroForm));
    return fields;
  }

  private foreignState(acroForm: PDFDict, input: InputForms): ForeignFormState {
    // /DA and /Q may be inherited from the document-level /AcroForm dictionary. If we are copying a foreign stream and the stream is getting
    // one of these values from its document's /AcroForm, we will need to copy the value explicitly so that it doesn't start getting its
    // default from the destination document.
    const defaultDa = textAt(this.context, acroForm.get(name('DA'))) ?? '';
    const defaultQ = numberAt(this.context, acroForm.get(name('Q'))) ?? 0;
    const fromDefaultDa = textAt(input.context, input.acroForm.get(name('DA'))) ?? '';
    const fromDefaultQ = numberAt(input.context, input.acroForm.get(name('Q'))) ?? 0;
    return {
      overrideDa: fromDefaultDa !== defaultDa,
      fromDefaultDa,
      overrideQ: fromDefaultQ !== defaultQ,
      fromDefaultQ,
      renames: new Map(),
    };
  }

  /**
   * `init_dr_map`: the document's /DR as an indirect dictionary with the /DR of the input merged into it. Runs once for an input, when its
   * first field comes up.
   */
  private initDrMap(acroForm: PDFDict, input: InputForms, copier: PdfObjectCopier, state: ForeignFormState): PDFRef {
    if (state.drRef) return state.drRef;
    // Ensure that we have a /DR that is an indirect dictionary object.
    const dr = dictAt(this.context, acroForm.get(name('DR'))) ?? PDFDict.withContext(this.context);
    makeResourcesIndirect(this.context, dr);
    const existing = acroForm.get(name('DR'));
    const drRef = existing instanceof PDFRef ? existing : this.context.register(dr);
    acroForm.set(name('DR'), drRef);
    // Merge the other document's /DR, creating a conflict map.
    const fromDrValue = input.acroForm.get(name('DR'));
    const fromDr = fromDrValue === undefined ? undefined : dictAt(this.context, copier.copy(fromDrValue));
    if (fromDr) {
      makeResourcesIndirect(this.context, fromDr);
      mergeResources(this.context, dr, fromDr, state.renames);
    }
    if (input.acroForm.get(name('NeedAppearances')) === PDFBool.True) acroForm.set(name('NeedAppearances'), PDFBool.True);
    state.drRef = drRef;
    return drRef;
  }

  /** `traverse_field`: walks the copy of a field and its kids, and makes each of them independent of the /AcroForm of the input. */
  private traverseCopiedField(top: PDFRef, acroForm: PDFDict, input: InputForms, copier: PdfObjectCopier, state: ForeignFormState): void {
    const seen = new Set<string>();
    for (const queue = [top]; queue.length > 0; queue.shift()) {
      const obj = dictAt(this.context, queue[0]);
      if (!obj || seen.has(queue[0].tag)) continue;
      seen.add(queue[0].tag);
      queue.push(...refsOf(arrayAt(this.context, obj.get(name('Kids')))));
      this.adjustInheritedFields(obj, acroForm, state);
      // Lazily initialize our /DR and the conflict map.
      const drRef = this.initDrMap(acroForm, input, copier, state);
      // The spec doesn't say anything about /DR on the field, but lots of writers put one there, and it is frequently the same as the
      // document-level /DR. To avoid having the field's /DR point to information that we are not maintaining, just reset it to that if it
      // exists. Empirical evidence suggests that many readers ignore /DR at the field level.
      if (obj.has(name('DR'))) obj.set(name('DR'), drRef);
      if (textAt(this.context, obj.get(name('DA'))) !== undefined && state.renames.size > 0) this.adjustDefaultAppearances(obj, state.renames);
    }
  }

  /**
   * `adjustInheritedFields`: a field that took its /DA or /Q from the /AcroForm of its input gets the value written on it when the
   * /AcroForm of the document has another one. A value the field has itself, or takes from an ancestor, is left.
   */
  private adjustInheritedFields(obj: PDFDict, acroForm: PDFDict, state: ForeignFormState): void {
    if (!(state.overrideDa || state.overrideQ)) return;
    // If this object has a field type, directly or inherited, it is a field and not just an annotation. In that case, we need to override
    // if we are getting a value from the document that is different from the value we would have gotten from the old document.
    if (state.overrideDa && this.index.inheritable(obj, 'DA') === undefined) {
      const da = textAt(this.context, acroForm.get(name('DA'))) ?? '';
      if (da !== state.fromDefaultDa) obj.set(name('DA'), textObject(state.fromDefaultDa));
    }
    if (state.overrideQ && this.index.inheritable(obj, 'Q') === undefined) {
      const q = numberAt(this.context, acroForm.get(name('Q'))) ?? 0;
      if (q !== state.fromDefaultQ) obj.set(name('Q'), PDFNumber.of(state.fromDefaultQ));
    }
  }

  /**
   * `adjustDefaultAppearances`: a /DA that names a resource of the /DR of its own input names it by the new name where merging the /DR
   * renamed it, so that the field is drawn with the font it was made for and not the one the document's /DR has under the old name.
   */
  private adjustDefaultAppearances(obj: PDFDict, renames: ResourceRenames): void {
    const da = this.context.lookup(obj.get(name('DA')));
    if (!(da instanceof PDFString || da instanceof PDFHexString)) return;
    const bytes = da.asBytes();
    const replaced = replaceResourceNames(bytes, renames, findResourceNames(bytes), encodeName);
    if (replaced) obj.set(name('DA'), stringFromBytes(replaced));
  }

  private adjustAppearanceStreams(pages: PDFPage[], renames: ResourceRenames): void {
    const adjusted = new Set<string>();
    for (const page of pages) {
      for (const annotation of refsOf(page.node.Annots())) {
        for (const stream of this.appearanceStreamsOf(dictAt(this.context, annotation))) {
          if (adjusted.has(stream.tag)) continue;
          adjusted.add(stream.tag);
          this.adjustAppearanceStream(stream, copyRenames(renames));
        }
      }
    }
  }

  /** The appearance streams of an annotation: each of /N, /R and /D is a stream or a dictionary of streams by appearance state. */
  private appearanceStreamsOf(annotation: PDFDict | undefined): PDFRef[] {
    const streams: PDFRef[] = [];
    const isStream = (value: unknown): value is PDFRef => value instanceof PDFRef && this.context.lookup(value) instanceof PDFRawStream;
    const appearance = dictAt(this.context, annotation?.get(name('AP')));
    for (const [, entry] of appearance?.entries() ?? []) {
      if (isStream(entry)) {
        streams.push(entry);
        continue;
      }
      for (const [, state] of dictAt(this.context, entry)?.entries() ?? []) {
        if (isStream(state)) streams.push(state);
      }
    }
    return streams;
  }

  /**
   * `adjustAppearanceStream`: gives an appearance stream its own resource dictionary in which the renamed resources are renamed too, and
   * writes its content with the new names, which makes it safe to regenerate the appearance of the field.
   */
  private adjustAppearanceStream(ref: PDFRef, renames: ResourceRenames): void {
    const stream = this.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return;
    const resourcesValue = stream.dict.get(name('Resources'));
    const original = dictAt(this.context, resourcesValue);
    if (!original) return;
    // Make sure this stream has its own private resource dictionary.
    const resources = original.clone(this.context);
    stream.dict.set(name('Resources'), resourcesValue instanceof PDFRef ? this.context.register(resources) : resources);
    // Create a dictionary with top-level keys so we can use mergeResources to force them to be unshared. We will also use this to resolve
    // conflicts that may already be in the resource dictionary.
    const mergeWith = PDFDict.withContext(this.context);
    for (const resourceType of renames.keys()) mergeWith.set(name(resourceType), PDFDict.withContext(this.context));
    mergeResources(this.context, resources, mergeWith);
    this.renameResourceKeys(resources, mergeWith, renames);
    // Deal with any conflicts by re-merging with mergeWith and updating our local copy of renames, which we will use to modify the stream contents.
    mergeResources(this.context, resources, mergeWith, renames);
    for (const [key, value] of resources.entries()) {
      if (dictAt(this.context, value)?.keys().length === 0) resources.delete(key);
    }
    this.rewriteStreamContent(ref, stream, renames);
  }

  /** Rename any keys in the resource dictionary that we remapped; a key the new name took is moved to `mergeWith` to be merged back under a free name. */
  private renameResourceKeys(resources: PDFDict, mergeWith: PDFDict, renames: ResourceRenames): void {
    for (const [resourceType, byName] of renames) {
      const subdictionary = dictAt(this.context, resources.get(name(resourceType)));
      if (!subdictionary) continue;
      for (const [oldKey, newKey] of byName) {
        const existingNew = subdictionary.get(name(newKey));
        if (existingNew !== undefined) dictAt(this.context, mergeWith.get(name(resourceType)))?.set(name(newKey), existingNew);
        const existingOld = subdictionary.get(name(oldKey));
        if (existingOld !== undefined) {
          subdictionary.set(name(newKey), existingOld);
          subdictionary.delete(name(oldKey));
        }
      }
    }
  }

  private rewriteStreamContent(ref: PDFRef, stream: PDFRawStream, renames: ResourceRenames): void {
    let content: Uint8Array;
    try {
      content = decodePDFRawStream(stream).decode();
    } catch {
      // qpdf: "Unable to parse appearance stream"; the stream keeps the names it has.
      return;
    }
    const replaced = replaceResourceNames(content, renames, findResourceNames(content), encodeName);
    if (!replaced) return;
    const packed = deflateSync(replaced);
    stream.dict.set(name('Filter'), name('FlateDecode'));
    stream.dict.delete(name('DecodeParms'));
    stream.dict.set(name('Length'), PDFNumber.of(packed.length));
    this.context.assign(ref, PDFRawStream.of(stream.dict, packed));
  }

  /** /SigFlags: a flag any input sets stays set. */
  private mergeSignatureFlags(acroForm: PDFDict, input: InputForms): void {
    const fromFlags = numberAt(this.context, input.acroForm.get(name('SigFlags'))) ?? 0;
    if (fromFlags === 0) return;
    // eslint-disable-next-line no-bitwise
    acroForm.set(name('SigFlags'), PDFNumber.of((numberAt(this.context, acroForm.get(name('SigFlags'))) ?? 0) | fromFlags));
  }

  /** /CO: the calculation order of the document continues with the fields of the input that were copied. */
  private mergeCalculationOrder(acroForm: PDFDict, input: InputForms, copier: PdfObjectCopier): void {
    const sourceOrder = refsOf(arrayAt(this.context, input.acroForm.get(name('CO'))));
    const copies = sourceOrder.map((field) => copier.copyOf(field)).filter((copy): copy is PDFRef => copy instanceof PDFRef);
    if (copies.length === 0) return;
    let order = arrayAt(this.context, acroForm.get(name('CO')));
    if (!order) {
      order = this.context.obj([]) as PDFArray;
      acroForm.set(name('CO'), order);
    }
    for (const copy of copies) order.push(copy);
  }
}
