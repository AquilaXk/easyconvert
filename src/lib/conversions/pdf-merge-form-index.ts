/*
 * The index of the form fields of a document and the renaming of fields that arrive with a name the document already has, translated from
 * qpdf (https://github.com/qpdf/qpdf), tag v12.4.2, commit 4eba95899886e851cc41d76886483b347612f2a8 (Apache-2.0, Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger):
 *
 *   libqpdf/QPDFAcroFormDocumentHelper.cc (SHA-256 845ce9f3...f03ee3): `AcroForm::analyze`, `AcroForm::traverseField`, `AcroForm::addFormField`,
 *     `AcroForm::addAndRenameFormFields`, `AcroForm::getFieldsWithQualifiedName`, `AcroForm::getFieldForAnnotation`
 *   libqpdf/QPDFFormFieldObjectHelper.cc (SHA-256 dc0858ab...46c976): `FormNode::fully_qualified_name`, `FormNode::root_field`,
 *     `FormNode::inherited`
 *   libqpdf/qpdf/AcroForm.hh (SHA-256 6537112d...e9b8ce): `FormNode::field`, `FormNode::widget`, `FormNode::FT`, `FormNode::T`, `FormNode::Kids`
 *
 * The structure, the names (in camelCase), the branches and the comments are qpdf's. What differs is the object model: qpdf's `QPDFObjGen`
 * is the tag of a pdf-lib reference, a direct object is skipped where qpdf warns and skips it, and qpdf's warnings are dropped. Changes for
 * this repository are in other files and other commits, each with its reason in its message.
 */
import { PDFArray, PDFDict, PDFHexString, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { arrayAt, dictAt, nameAt, name, textAt, textObject } from './pdf-merge-objects';

/** Deepest field tree that `traverseField` follows ("Arbitrarily cut off recursion at a fixed depth"). */
const MAX_FIELD_DEPTH = 100;
/** `FormNode` walks up the parents without a loop check until the depth becomes suspicious. */
const SUSPICIOUS_DEPTH = 10;

interface FieldEntry {
  ref: PDFRef;
  annotations: PDFRef[];
  name: string;
}

const isString = (context: PDFContext, value: PDFObject | undefined): boolean => {
  const resolved = value === undefined ? undefined : context.lookup(value);
  return resolved instanceof PDFString || resolved instanceof PDFHexString;
};

export class FormIndex {
  private readonly fields = new Map<string, FieldEntry>();
  private readonly annotationToField = new Map<string, PDFRef>();
  private readonly badFields = new Set<string>();
  private readonly unnamedFields = new Set<string>();
  private readonly nameToFields = new Map<string, Set<string>>();

  constructor(private readonly context: PDFContext) {}

  /** `FormNode::Parent`: the dictionary a field names as its parent, as a reference. */
  parentOf(field: PDFDict): PDFRef | undefined {
    const parent = field.get(name('Parent'));
    return parent instanceof PDFRef && dictAt(this.context, parent) ? parent : undefined;
  }

  /** `FormNode::inherited`: the value of `key` the field takes from its ancestors. */
  inherited(field: PDFDict, key: string): PDFObject | undefined {
    let node = field;
    const seen = new Set<PDFDict>();
    let depth = 0;
    let parentRef = this.parentOf(node);
    while (parentRef && (++depth < SUSPICIOUS_DEPTH || !seen.has(node))) {
      seen.add(node);
      node = dictAt(this.context, parentRef) as PDFDict;
      const value = node.get(name(key));
      if (value !== undefined) return value;
      parentRef = this.parentOf(node);
    }
    return undefined;
  }

  /** `FormNode::inheritable_value`: the value of `key` on the field itself, or else on an ancestor. */
  inheritable(field: PDFDict, key: string): PDFObject | undefined {
    return field.get(name(key)) ?? this.inherited(field, key);
  }

  /** `FormNode::fully_qualified_name`. */
  fullyQualifiedName(field: PDFDict): string {
    let result = '';
    let node: PDFDict | undefined = field;
    const seen = new Set<PDFDict>();
    let depth = 0;
    while (node && (++depth < SUSPICIOUS_DEPTH || !seen.has(node))) {
      seen.add(node);
      const partial = textAt(this.context, node.get(name('T')));
      if (partial !== undefined) result = result === '' ? partial : `${partial}.${result}`;
      const parentRef = this.parentOf(node);
      node = parentRef ? dictAt(this.context, parentRef) : undefined;
    }
    return result;
  }

  /** `FormNode::root_field`: the field at the top of the tree that `field` is in. */
  rootField(field: PDFRef): PDFRef {
    let current = field;
    const seen = new Set<string>();
    let depth = 0;
    let parent = this.parentOf(dictAt(this.context, current) as PDFDict);
    while (parent && (++depth < SUSPICIOUS_DEPTH || !seen.has(current.tag))) {
      seen.add(current.tag);
      current = parent;
      parent = this.parentOf(dictAt(this.context, current) as PDFDict);
    }
    return current;
  }

  /** `FormNode::field`: a dictionary with a name, kids or a type is a field. */
  private isField(node: PDFDict): boolean {
    return (
      isString(this.context, node.get(name('T'))) ||
      arrayAt(this.context, node.get(name('Kids'))) !== undefined ||
      nameAt(this.context, this.inheritable(node, 'FT')) !== undefined
    );
  }

  /** `FormNode::widget`: a dictionary without kids that looks like an annotation is a widget. */
  private isWidget(node: PDFDict): boolean {
    if (arrayAt(this.context, node.get(name('Kids')))) return false;
    return node.has(name('Subtype')) || node.has(name('Rect')) || node.has(name('AP'));
  }

  /** `AcroForm::getFieldsWithQualifiedName`. */
  fieldsWithQualifiedName(qualifiedName: string): Set<string> {
    return this.nameToFields.get(qualifiedName) ?? new Set();
  }

  /** `AcroForm::getFieldForAnnotation`: the field a widget annotation belongs to. */
  fieldForAnnotation(annotation: PDFRef): PDFRef | undefined {
    const dict = dictAt(this.context, annotation);
    if (dict?.get(name('Subtype')) !== name('Widget')) return undefined;
    return this.annotationToField.get(annotation.tag);
  }

  /**
   * `AcroForm::analyze` for a document: traverses the /Fields of its /AcroForm to find the widget annotations and map them to their fields,
   * then treats a widget annotation of a page that no field reaches as a field of its own.
   */
  analyze(fields: PDFArray | undefined, widgetAnnotationsOfPages: Iterable<PDFRef>): void {
    for (let at = 0; fields && at < fields.size(); at += 1) {
      this.traverseField(fields.get(at), undefined, 0);
    }
    // All Widget annotations should have been encountered by traversing /AcroForm, but in case any weren't, find them by walking through
    // pages, and treat any widget annotation that is not associated with a field as its own field.
    for (const annotation of widgetAnnotationsOfPages) {
      if (!this.annotationToField.has(annotation.tag)) {
        this.annotationToField.set(annotation.tag, annotation);
        this.entryOf(annotation).annotations.push(annotation);
      }
    }
  }

  private entryOf(field: PDFRef): FieldEntry {
    let entry = this.fields.get(field.tag);
    if (!entry) {
      entry = { ref: field, annotations: [], name: '' };
      this.fields.set(field.tag, entry);
    }
    return entry;
  }

  /** `AcroForm::traverseField`. */
  private traverseField(fieldObject: PDFObject, parent: PDFRef | undefined, depth: number): boolean {
    if (depth > MAX_FIELD_DEPTH) return false;
    // A direct object cannot be tracked or shared between a field and its annotation.
    if (!(fieldObject instanceof PDFRef)) return false;
    const field = fieldObject;
    if (parent && field.tag === parent.tag) return false;
    const node = dictAt(this.context, field);
    if (!node) return false;
    if (this.unnamedFields.has(field.tag)) this.badFields.add(field.tag);
    if (this.fields.has(field.tag) || this.annotationToField.has(field.tag) || this.badFields.has(field.tag)) return false;

    // A dictionary encountered while traversing the /AcroForm field may be a form field, an annotation, or the merger of the two. A field
    // that has no fields below it is a terminal. If a terminal field looks like an annotation, it is an annotation because annotation
    // dictionary fields can be merged with terminal field dictionaries.
    const isField = this.isField(node);
    const isAnnotation = this.isWidget(node);
    if (!isField && !isAnnotation) return false;

    if (isAnnotation) {
      const ourField = isField || !parent ? field : parent;
      this.entryOf(ourField).annotations.push(field);
      this.annotationToField.set(field.tag, ourField);
    }
    if (!isField) return true;

    const parentOfNode = node.get(name('Parent'));
    if (depth !== 0 && (parentOfNode instanceof PDFRef ? parentOfNode.tag : undefined) !== parent?.tag) {
      const outcome = this.checkParent(node, field, parent);
      if (outcome !== 'corrected') return outcome === 'two-parents';
    }
    this.registerName(field, node, isAnnotation);
    return this.traverseKids(node, field, depth);
  }

  /** The /Parent of a field is not the field it was found under: finds out why, and sets it right where the parent has the field as a kid. */
  private checkParent(node: PDFDict, field: PDFRef, parent: PDFRef | undefined): 'two-parents' | 'loop' | 'corrected' {
    const parentKids = arrayAt(this.context, dictAt(this.context, node.get(name('Parent')))?.get(name('Kids')));
    const kidTags = new Set<string>();
    for (let at = 0; parentKids && at < parentKids.size(); at += 1) {
      const kid = parentKids.get(at);
      if (kid instanceof PDFRef) kidTags.add(kid.tag);
    }
    // "while traversing /AcroForm found field with two parents"
    if (kidTags.has(field.tag)) return 'two-parents';
    // "loop detected while traversing /AcroForm"
    if (parent && kidTags.has(parent.tag)) return 'loop';
    // "encountered invalid /Parent entry while traversing /AcroForm; correcting"
    if (parent) node.set(name('Parent'), parent);
    return 'corrected';
  }

  private registerName(field: PDFRef, node: PDFDict, isAnnotation: boolean): void {
    if (textAt(this.context, node.get(name('T'))) !== undefined) {
      const old = this.fields.get(field.tag);
      if (old && old.name !== '') {
        // We might be updating after a name change, so remove any old information
        this.nameToFields.get(old.name)?.delete(field.tag);
      }
      const qualified = this.fullyQualifiedName(node);
      this.entryOf(field).name = qualified;
      const withName = this.nameToFields.get(qualified) ?? new Set<string>();
      withName.add(field.tag);
      this.nameToFields.set(qualified, withName);
    } else if (!isAnnotation) {
      this.unnamedFields.add(field.tag);
    }
  }

  private traverseKids(node: PDFDict, field: PDFRef, depth: number): boolean {
    const kids = arrayAt(this.context, node.get(name('Kids')));
    for (let at = 0; kids && at < kids.size(); at += 1) {
      const kid = kids.get(at);
      if (kid instanceof PDFRef && this.badFields.has(kid.tag)) continue;
      if (!this.traverseField(kid, field, 1 + depth) && kid instanceof PDFRef) this.badFields.add(kid.tag);
    }
    return true;
  }

  /** `AcroForm::addFormField`: puts `field` into the /Fields of the /AcroForm and into the index. */
  addFormField(field: PDFRef, acroFormFields: PDFArray): void {
    acroFormFields.push(field);
    this.traverseField(field, undefined, 0);
  }

  /**
   * `AcroForm::addAndRenameFormFields`: adds the fields and, for each fully qualified name that the document already has, appends the
   * first `+n` that makes it unique to the partial name (/T) of the fields in that group.
   */
  addAndRenameFormFields(fields: PDFRef[], acroFormFields: PDFArray): void {
    const renames = new Map<string, string>();
    const seen = new Set<string>();
    for (const queue = [...fields]; queue.length > 0; queue.shift()) {
      const ref = queue[0];
      const obj = dictAt(this.context, ref);
      if (!obj || seen.has(ref.tag)) continue;
      seen.add(ref.tag);
      const kids = arrayAt(this.context, obj.get(name('Kids')));
      for (let at = 0; kids && at < kids.size(); at += 1) {
        const kid = kids.get(at);
        if (kid instanceof PDFRef) queue.push(kid);
      }
      if (obj.has(name('T'))) this.renamePartialName(obj, renames);
    }
    for (const field of fields) this.addFormField(field, acroFormFields);
  }

  private renamePartialName(obj: PDFDict, renames: Map<string, string>): void {
    // Find something we can append to the partial name that makes the fully qualified name unique. When we find something, reuse the same
    // suffix for all fields in this group with the same name. We can only change the name of fields that have /T, and this field's /T is
    // always at the end of the fully qualified name, appending to /T has the effect of appending the same thing to the fully qualified name.
    const oldName = this.fullyQualifiedName(obj);
    let append = renames.get(oldName);
    if (append === undefined) {
      let newName = oldName;
      let suffix = 0;
      append = '';
      while (this.fieldsWithQualifiedName(newName).size > 0) {
        suffix += 1;
        append = `+${suffix}`;
        newName = oldName + append;
      }
      renames.set(oldName, append);
    }
    if (append !== '') {
      obj.set(name('T'), textObject((textAt(this.context, obj.get(name('T'))) ?? '') + append));
    }
  }
}
