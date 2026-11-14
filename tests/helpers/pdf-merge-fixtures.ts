import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString, StandardFonts, type PDFObject, type PDFPage } from 'pdf-lib';

/** Builders and readers of the PDF merge tests: documents with forms, outlines, links, destinations and page labels. */

export interface OutlineSpec {
  title: string;
  /** Index of the page the item opens; `null` makes an item with no destination. */
  page: number | null;
  children?: OutlineSpec[];
  /** An item that is closed in the viewer (negative /Count). */
  closed?: boolean;
}

export interface FormSpec {
  text: string;
  checked: boolean;
  radio: string;
}

const RADIO_OPTIONS = ['a', 'b', 'c'];
const FIELD_NAMES = { text: 'name', checkbox: 'agree', radio: 'choice' };

/** A one-page form with a text field, a check box and a radio group, named the same in every call. */
export async function formPdf(spec: FormSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  const text = form.createTextField(FIELD_NAMES.text);
  text.setText(spec.text);
  text.addToPage(page, { x: 50, y: 230, width: 200, height: 24 });
  const box = form.createCheckBox(FIELD_NAMES.checkbox);
  if (spec.checked) box.check();
  box.addToPage(page, { x: 50, y: 190, width: 20, height: 20 });
  const radio = form.createRadioGroup(FIELD_NAMES.radio);
  RADIO_OPTIONS.forEach((option, index) => radio.addOptionToPage(option, page, { x: 50 + index * 40, y: 140, width: 20, height: 20 }));
  radio.select(spec.radio);
  return Buffer.from(await doc.save());
}

export const RESOURCE_FORM_DA = '/Helv 12 Tf 0 g';

/**
 * A one-page form with a text field "f" that takes its /DA from the /AcroForm and draws with the font /Helv of the /DR, which is `font`;
 * the appearance stream of the widget names /Helv too. Two of them with different fonts have a /DR name in conflict.
 */
export async function resourceFormPdf(font: StandardFonts, text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const form = doc.getForm();
  const field = form.createTextField('f');
  field.setText(text);
  field.addToPage(page, { x: 50, y: 230, width: 200, height: 24 });
  const fontRef = (await doc.embedFont(font)).ref;
  const { context } = doc;
  form.acroForm.dict.set(PDFName.of('DR'), context.obj({ Font: { Helv: fontRef } }));
  form.acroForm.dict.set(PDFName.of('DA'), PDFString.of(RESOURCE_FORM_DA));
  field.acroField.dict.delete(PDFName.of('DA'));
  const appearance = context.register(
    context.stream(`/Tx BMC q BT ${RESOURCE_FORM_DA} 2 6 Td (${text}) Tj ET Q EMC`, {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, 200, 24],
      Resources: { Font: { Helv: fontRef } },
    })
  );
  field.acroField.getWidgets()[0].dict.set(PDFName.of('AP'), context.obj({ N: appearance }));
  return Buffer.from(await doc.save({ updateFieldAppearances: false }));
}

/** A document of `count` pages, each with its own text, so a page can be told apart after a merge. */
export async function textPdf(label: string, count: number): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  for (let index = 0; index < count; index += 1) {
    doc.addPage([300 + index, 400]).drawText(`${label} page ${index + 1}`, { x: 20, y: 20 });
  }
  return doc;
}

function pageRef(doc: PDFDocument, index: number): PDFRef {
  return doc.getPage(index).ref;
}

function outlineItems(doc: PDFDocument, parent: PDFRef, specs: OutlineSpec[]): { refs: PDFRef[]; total: number } {
  const { context } = doc;
  const refs = specs.map(() => context.nextRef());
  let total = 0;
  specs.forEach((spec, index) => {
    const dict = context.obj({ Title: PDFString.of(spec.title), Parent: parent });
    if (spec.page !== null) dict.set(PDFName.of('Dest'), context.obj([pageRef(doc, spec.page), 'Fit']));
    if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1]);
    if (index < specs.length - 1) dict.set(PDFName.of('Next'), refs[index + 1]);
    const inner = spec.children?.length ? outlineItems(doc, refs[index], spec.children) : null;
    if (inner) {
      dict.set(PDFName.of('First'), inner.refs[0]);
      dict.set(PDFName.of('Last'), inner.refs[inner.refs.length - 1]);
      dict.set(PDFName.of('Count'), PDFNumber.of((spec.closed ? -1 : 1) * inner.total));
    }
    context.assign(refs[index], dict);
    total += 1 + (inner?.total ?? 0);
  });
  return { refs, total };
}

/** Gives `doc` an /Outlines tree of `specs`. */
export function addOutlines(doc: PDFDocument, specs: OutlineSpec[]): void {
  const { context } = doc;
  const root = context.nextRef();
  const { refs, total } = outlineItems(doc, root, specs);
  context.assign(root, context.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: total }));
  doc.catalog.set(PDFName.of('Outlines'), root);
}

/** Adds a link annotation to page `from`; `target` is the /Dest or the /A entry of the link. */
export function addLink(doc: PDFDocument, from: number, entries: Record<string, PDFObject>): void {
  const { context } = doc;
  const link = context.register(context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 100, 40], ...entries }));
  doc.getPage(from).node.addAnnot(link);
}

/** The /Names /Dests tree of `doc` holding `names`, pointing at the page indexes given. */
export function addNamedDestinations(doc: PDFDocument, names: Record<string, number>): void {
  const { context } = doc;
  const pairs = Object.entries(names)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .flatMap(([name, page]) => [PDFString.of(name), context.obj([pageRef(doc, page), 'Fit'])]);
  const dests = context.obj({ Names: pairs });
  doc.catalog.set(PDFName.of('Names'), context.obj({ Dests: dests }));
}

/** /PageLabels of `doc` from `labels`: a page index and the label dictionary that starts there. */
export function addPageLabels(doc: PDFDocument, labels: Array<[number, Record<string, PDFObject | string | number>]>): void {
  const { context } = doc;
  const nums = labels.flatMap(([index, label]) => [PDFNumber.of(index), context.obj(label)]);
  doc.catalog.set(PDFName.of('PageLabels'), context.obj({ Nums: nums }));
}

export const bytesOf = async (doc: PDFDocument): Promise<Buffer> => Buffer.from(await doc.save());

export function lookupDict(doc: PDFDocument, value: PDFObject | undefined): PDFDict | undefined {
  const resolved = value === undefined ? undefined : doc.context.lookup(value);
  return resolved instanceof PDFDict ? resolved : undefined;
}

export function lookupArray(doc: PDFDocument, value: PDFObject | undefined): PDFArray | undefined {
  const resolved = value === undefined ? undefined : doc.context.lookup(value);
  return resolved instanceof PDFArray ? resolved : undefined;
}

/** Index of the page that `value` (a reference) names in `doc`, or -1. */
export function pageIndexOf(doc: PDFDocument, value: PDFObject | undefined): number {
  return value instanceof PDFRef ? doc.getPages().findIndex((page) => page.ref.tag === value.tag) : -1;
}

export interface ReadOutline {
  title: string;
  page: number;
  closed: boolean;
  children: ReadOutline[];
}

function titleOf(doc: PDFDocument, item: PDFDict): string {
  const title = doc.context.lookup(item.get(PDFName.of('Title')));
  return title instanceof PDFString ? title.decodeText() : '';
}

function destinationPage(doc: PDFDocument, item: PDFDict): number {
  const dest = lookupArray(doc, item.get(PDFName.of('Dest')));
  if (dest) return pageIndexOf(doc, dest.get(0));
  const action = lookupDict(doc, item.get(PDFName.of('A')));
  const target = lookupArray(doc, action?.get(PDFName.of('D')));
  return target ? pageIndexOf(doc, target.get(0)) : -1;
}

function readLevel(doc: PDFDocument, first: PDFObject | undefined): ReadOutline[] {
  const items: ReadOutline[] = [];
  const seen = new Set<PDFDict>();
  let item = lookupDict(doc, first);
  while (item && !seen.has(item)) {
    seen.add(item);
    const count = doc.context.lookupMaybe(item.get(PDFName.of('Count')), PDFNumber)?.asNumber() ?? 0;
    items.push({
      title: titleOf(doc, item),
      page: destinationPage(doc, item),
      closed: count < 0,
      children: readLevel(doc, item.get(PDFName.of('First'))),
    });
    item = lookupDict(doc, item.get(PDFName.of('Next')));
  }
  return items;
}

/** The outline of `doc` as nested items with the index of the page each one opens. */
export function readOutlines(doc: PDFDocument): ReadOutline[] {
  const root = lookupDict(doc, doc.catalog.get(PDFName.of('Outlines')));
  return root ? readLevel(doc, root.get(PDFName.of('First'))) : [];
}

/** The page index each link annotation of page `index` opens (-1 for none), by what the link carries. */
export function readLinks(doc: PDFDocument, index: number): Array<{ subtype: string; page: number; uri?: string }> {
  const page: PDFPage = doc.getPage(index);
  const annots = lookupArray(doc, page.node.get(PDFName.of('Annots')));
  const links: Array<{ subtype: string; page: number; uri?: string }> = [];
  for (let at = 0; annots && at < annots.size(); at += 1) {
    const annot = lookupDict(doc, annots.get(at));
    if (annot?.get(PDFName.of('Subtype')) !== PDFName.of('Link')) continue;
    const action = lookupDict(doc, annot.get(PDFName.of('A')));
    const uri = action?.get(PDFName.of('URI'));
    if (uri instanceof PDFString) {
      links.push({ subtype: 'Link', page: -1, uri: uri.decodeText() });
      continue;
    }
    const dest = lookupArray(doc, annot.get(PDFName.of('Dest')) ?? action?.get(PDFName.of('D')));
    links.push({ subtype: 'Link', page: dest ? pageIndexOf(doc, dest.get(0)) : -1 });
  }
  return links;
}

/** The named destinations of `doc`, from its /Names /Dests tree, as the page index each name opens. */
export function readNamedDestinations(doc: PDFDocument): Record<string, number> {
  const names = lookupDict(doc, doc.catalog.get(PDFName.of('Names')));
  const dests = lookupDict(doc, names?.get(PDFName.of('Dests')));
  const nums = lookupArray(doc, dests?.get(PDFName.of('Names')));
  const result: Record<string, number> = {};
  for (let at = 0; nums && at + 1 < nums.size(); at += 2) {
    const key = doc.context.lookup(nums.get(at));
    const dest = lookupArray(doc, nums.get(at + 1));
    if (key instanceof PDFString && dest) result[key.decodeText()] = pageIndexOf(doc, dest.get(0));
  }
  return result;
}

/** The flat /Nums of the /PageLabels of `doc` as `[index, label]` pairs with the label dictionary read as plain values. */
export function readPageLabels(doc: PDFDocument): Array<[number, Record<string, string | number>]> {
  const labels = lookupDict(doc, doc.catalog.get(PDFName.of('PageLabels')));
  const nums = lookupArray(doc, labels?.get(PDFName.of('Nums')));
  const result: Array<[number, Record<string, string | number>]> = [];
  for (let at = 0; nums && at + 1 < nums.size(); at += 2) {
    const index = doc.context.lookupMaybe(nums.get(at), PDFNumber)?.asNumber() ?? -1;
    const dict = lookupDict(doc, nums.get(at + 1));
    const plain: Record<string, string | number> = {};
    for (const [key, value] of dict?.entries() ?? []) {
      const resolved = doc.context.lookup(value);
      if (resolved instanceof PDFNumber) plain[key.decodeText()] = resolved.asNumber();
      else if (resolved instanceof PDFString) plain[key.decodeText()] = resolved.decodeText();
      else if (resolved instanceof PDFName) plain[key.decodeText()] = resolved.decodeText();
    }
    result.push([index, plain]);
  }
  return result;
}
