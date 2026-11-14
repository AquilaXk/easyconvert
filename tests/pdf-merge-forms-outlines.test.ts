import { describe, expect, it } from 'vitest';
import { decodePDFRawStream, PDFDict, PDFDocument, PDFName, PDFNumber, type PDFRawStream, type PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { mergePdfBuffers } from '../src/lib/jobs';
import { qpdfCheckPasses } from './helpers/encrypted-pdf-fixtures';
import {
  addLink,
  addNamedDestinations,
  addOutlines,
  addPageLabels,
  bytesOf,
  formPdf,
  lookupArray,
  lookupDict,
  readLinks,
  readNamedDestinations,
  readOutlines,
  readPageLabels,
  resourceFormPdf,
  textPdf,
} from './helpers/pdf-merge-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * What a merge keeps of the parts of a document that live outside its pages: form fields, bookmarks, links, named destinations,
 * page labels and the document information. Each case merges inputs built here and reads the result back with pdf-lib, with
 * pdf.js for the fields and with qpdf --check.
 */

const qpdfMissing = skipWithoutTools('qpdf');

async function mergedDocument(buffers: Buffer[], names?: string[]): Promise<PDFDocument> {
  return PDFDocument.load(await mergePdfBuffers(buffers, { names }), { updateMetadata: false });
}

describe('forms of the inputs', () => {
  const alice = (): Promise<Buffer> => formPdf({ text: 'Alice', checked: true, radio: 'b' });
  const bob = (): Promise<Buffer> => formPdf({ text: 'Bob', checked: false, radio: 'a' });

  it('keeps the fields of both inputs and renames the ones whose names collide', async () => {
    const doc = await mergedDocument([await alice(), await bob()]);
    const fields = doc.getForm().getFields();
    expect(fields.map((field) => field.getName()).sort()).toEqual(['agree', 'agree+1', 'choice', 'choice+1', 'name', 'name+1']);
    expect(fields.every((field) => field.acroField.getWidgets().length > 0)).toBe(true);
  });

  it('keeps the value, the check box state and the selected radio button of every field', async () => {
    const form = (await mergedDocument([await alice(), await bob()])).getForm();
    expect(form.getTextField('name').getText()).toBe('Alice');
    expect(form.getTextField('name+1').getText()).toBe('Bob');
    expect(form.getCheckBox('agree').isChecked()).toBe(true);
    expect(form.getCheckBox('agree+1').isChecked()).toBe(false);
    expect(form.getRadioGroup('choice').getSelected()).toBe('b');
    expect(form.getRadioGroup('choice+1').getSelected()).toBe('a');
  });

  it('points the widgets of each field at the copied page that holds them', async () => {
    const doc = await mergedDocument([await alice(), await bob()]);
    const form = doc.getForm();
    const pageOf = (name: string): number => {
      const widget = form.getField(name).acroField.getWidgets()[0];
      const pageRef = widget.dict.get(PDFName.of('P'));
      return doc.getPages().findIndex((page) => page.ref === pageRef);
    };
    expect(pageOf('name')).toBe(0);
    expect(pageOf('name+1')).toBe(1);
    expect(pageOf('choice+1')).toBe(1);
  });

  it('lists every field of the merged file in /AcroForm', async () => {
    const doc = await mergedDocument([await alice(), await bob()]);
    const acroForm = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
    expect(lookupArray(doc, acroForm?.get(PDFName.of('Fields')))?.size()).toBe(6);
  });

  it.skipIf(qpdfMissing)('writes a file that qpdf --check accepts', async () => {
    expect(qpdfCheckPasses(await mergePdfBuffers([await alice(), await bob()]))).toBe(true);
  });

  it('lists the fields of the merged file in pdf.js', async () => {
    type Page = { getAnnotations(): Promise<Array<{ fieldName?: string; fieldType?: string }>> };
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument(options: { data: Uint8Array; verbosity: number }): { promise: Promise<{ numPages: number; getPage(index: number): Promise<Page> }>; destroy(): Promise<void> };
    };
    const merged = await mergePdfBuffers([await alice(), await bob()]);
    const task = pdfjs.getDocument({ data: new Uint8Array(merged), verbosity: 0 });
    const loaded = await task.promise;
    const names = new Set<string>();
    for (let index = 1; index <= loaded.numPages; index += 1) {
      for (const annotation of await (await loaded.getPage(index)).getAnnotations()) {
        if (annotation.fieldName) names.add(annotation.fieldName);
      }
    }
    await task.destroy();
    expect([...names].sort()).toEqual(['agree', 'agree+1', 'choice', 'choice+1', 'name', 'name+1']);
  });

  it('renames a default resource of the second input that the first input uses for another font, in the /DR, the fields and the appearance streams', async () => {
    const doc = await mergedDocument([await resourceFormPdf(StandardFonts.Helvetica, 'one'), await resourceFormPdf(StandardFonts.CourierBold, 'two')]);
    const acroForm = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
    const fonts = lookupDict(doc, lookupDict(doc, acroForm?.get(PDFName.of('DR')))?.get(PDFName.of('Font')));
    const fontName = (key: string): string | undefined => {
      const font = lookupDict(doc, fonts?.get(PDFName.of(key)));
      return font ? String(doc.context.lookup(font.get(PDFName.of('BaseFont')))) : undefined;
    };
    expect(fonts?.keys().map((key) => key.decodeText()).sort()).toEqual(['Helv', 'Helv_1']);
    expect(fontName('Helv')).toBe('/Helvetica');
    expect(fontName('Helv_1')).toBe('/Courier-Bold');
    const appearanceOf = (page: number): { content: string; fontKeys: string[] } => {
      const widget = lookupDict(doc, lookupArray(doc, doc.getPage(page).node.get(PDFName.of('Annots')))?.get(0));
      const stream = doc.context.lookup(lookupDict(doc, widget?.get(PDFName.of('AP')))?.get(PDFName.of('N')));
      const resources = lookupDict(doc, (stream as PDFRawStream).dict.get(PDFName.of('Resources')));
      const streamFonts = lookupDict(doc, resources?.get(PDFName.of('Font')));
      return {
        content: decodePDFRawStream(stream as PDFRawStream).decode().reduce((text, byte) => text + String.fromCharCode(byte), ''),
        fontKeys: streamFonts?.keys().map((key) => key.decodeText()) ?? [],
      };
    };
    expect(appearanceOf(0)).toEqual({ content: expect.stringContaining('/Helv 12 Tf'), fontKeys: ['Helv'] });
    expect(appearanceOf(1)).toEqual({ content: expect.stringContaining('/Helv_1 12 Tf'), fontKeys: ['Helv_1'] });
  });

  it('writes the default appearance of the second input on a field that took it from its /AcroForm, with the renamed font', async () => {
    const doc = await mergedDocument([await resourceFormPdf(StandardFonts.Helvetica, 'one'), await resourceFormPdf(StandardFonts.CourierBold, 'two')]);
    const daOf = (fieldName: string): string | undefined => lookupString(doc, doc.getForm().getField(fieldName).acroField.dict.get(PDFName.of('DA')));
    // The first field keeps inheriting /Helv from the /AcroForm; the second would inherit it too and draw with Helvetica, not Courier.
    expect(daOf('f')).toBeUndefined();
    expect(daOf('f+1')).toBe('/Helv_1 12 Tf 0 g');
  });

  it('leaves a field alone when no other input has its name', async () => {
    const plain = await textPdf('plain', 1);
    const doc = await mergedDocument([await alice(), await bytesOf(plain)]);
    expect(doc.getForm().getFields().map((field) => field.getName()).sort()).toEqual(['agree', 'choice', 'name']);
  });

  it('merges the form of a later input when the first one has no form', async () => {
    const doc = await mergedDocument([await bytesOf(await textPdf('plain', 2)), await bob()]);
    const form = doc.getForm();
    expect(form.getTextField('name').getText()).toBe('Bob');
    expect(doc.getPageCount()).toBe(3);
  });

  it('treats a widget that /Fields does not list as a field of its own', async () => {
    const source = await PDFDocument.load(await bob());
    lookupDict(source, source.catalog.get(PDFName.of('AcroForm')))?.set(PDFName.of('Fields'), source.context.obj([]));
    const doc = await mergedDocument([await alice(), await bytesOf(source)]);
    expect(doc.getForm().getFields().map((field) => field.getName()).sort()).toEqual(['agree', 'agree+1', 'choice', 'choice+1', 'name', 'name+1']);
  });

  it('ends on a field tree that loops back on itself', async () => {
    const source = await PDFDocument.load(await bob());
    const field = source.getForm().getTextField('name').acroField;
    const [widget] = field.getWidgets();
    widget.dict.set(PDFName.of('Kids'), source.context.obj([field.ref]));
    const doc = await mergedDocument([await bytesOf(source), await alice()]);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getForm().getFields().length).toBeGreaterThanOrEqual(3);
  });

  it('merges the signature flags of the inputs', async () => {
    const withFlags = async (flags: number): Promise<Buffer> => {
      const doc = await PDFDocument.load(await bob());
      const acroForm = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
      acroForm?.set(PDFName.of('SigFlags'), PDFNumber.of(flags));
      return bytesOf(doc);
    };
    const doc = await mergedDocument([await withFlags(1), await withFlags(2)]);
    const acroForm = lookupDict(doc, doc.catalog.get(PDFName.of('AcroForm')));
    expect(doc.context.lookupMaybe(acroForm?.get(PDFName.of('SigFlags')), PDFNumber)?.asNumber()).toBe(3);
  });
});

function lookupString(doc: PDFDocument, value: unknown): string | undefined {
  const resolved = value === undefined ? undefined : doc.context.lookup(value as never);
  return resolved instanceof PDFString ? resolved.decodeText() : undefined;
}

describe('bookmarks of the inputs', () => {
  async function outlined(label: string, pages: number, items: Parameters<typeof addOutlines>[1]): Promise<Buffer> {
    const doc = await textPdf(label, pages);
    addOutlines(doc, items);
    return bytesOf(doc);
  }

  it('keeps each input outline under a top-level item named by its file name, with destinations on the copied pages', async () => {
    const first = await outlined('A', 3, [
      { title: 'Chapter 1', page: 0, children: [{ title: 'Section 1.1', page: 1 }] },
      { title: 'Chapter 2', page: 2 },
    ]);
    const second = await outlined('B', 2, [{ title: 'Intro', page: 0 }, { title: 'End', page: 1 }]);
    const doc = await mergedDocument([first, second], ['report.pdf', 'appendix.PDF']);
    expect(readOutlines(doc)).toEqual([
      {
        title: 'report',
        page: 0,
        closed: false,
        children: [
          { title: 'Chapter 1', page: 0, closed: false, children: [{ title: 'Section 1.1', page: 1, closed: false, children: [] }] },
          { title: 'Chapter 2', page: 2, closed: false, children: [] },
        ],
      },
      {
        title: 'appendix',
        page: 3,
        closed: false,
        children: [
          { title: 'Intro', page: 3, closed: false, children: [] },
          { title: 'End', page: 4, closed: false, children: [] },
        ],
      },
    ]);
  });

  it('gives an input with no outline a top-level item for its first page', async () => {
    const doc = await mergedDocument([await bytesOf(await textPdf('A', 2)), await bytesOf(await textPdf('B', 2))], ['one.pdf', 'two.pdf']);
    expect(readOutlines(doc).map(({ title, page, children }) => ({ title, page, children: children.length }))).toEqual([
      { title: 'one', page: 0, children: 0 },
      { title: 'two', page: 2, children: 0 },
    ]);
  });

  it('writes no outline for inputs that have none and carry no file name', async () => {
    const doc = await mergedDocument([await bytesOf(await textPdf('A', 1)), await bytesOf(await textPdf('B', 1))]);
    expect(doc.catalog.has(PDFName.of('Outlines'))).toBe(false);
  });

  it('keeps an item that is closed in the input closed', async () => {
    const first = await outlined('A', 2, [{ title: 'Part', page: 0, closed: true, children: [{ title: 'Inner', page: 1 }] }]);
    const doc = await mergedDocument([first, await bytesOf(await textPdf('B', 1))], ['a.pdf', 'b.pdf']);
    expect(readOutlines(doc)[0].children[0]).toMatchObject({ title: 'Part', closed: true });
  });

  it('drops an item whose destination is no page of the input, and keeps one that only has children with destinations', async () => {
    const source = await textPdf('A', 2);
    addOutlines(source, [
      { title: 'Gone', page: null },
      { title: 'Parent without a destination', page: null, children: [{ title: 'Kept', page: 1 }] },
    ]);
    const doc = await mergedDocument([await bytesOf(source)], ['a.pdf']);
    const [top] = readOutlines(doc);
    expect(top.children.map((item) => item.title)).toEqual(['Parent without a destination']);
    expect(top.children[0].children).toEqual([{ title: 'Kept', page: 1, closed: false, children: [] }]);
  });

  it('ends on an outline whose items loop', async () => {
    const source = await textPdf('A', 2);
    addOutlines(source, [{ title: 'One', page: 0 }, { title: 'Two', page: 1 }]);
    const root = lookupDict(source, source.catalog.get(PDFName.of('Outlines')));
    const first = root?.get(PDFName.of('First')) as PDFRef;
    lookupDict(source, lookupDict(source, first)?.get(PDFName.of('Next')))?.set(PDFName.of('Next'), first);
    const doc = await mergedDocument([await bytesOf(source)], ['loop.pdf']);
    expect(readOutlines(doc)[0].children.map((item) => item.title)).toEqual(['One', 'Two']);
  });

  it.skipIf(qpdfMissing)('writes a file that qpdf --check accepts', async () => {
    const first = await outlined('A', 2, [{ title: 'Chapter', page: 1 }]);
    expect(qpdfCheckPasses(await mergePdfBuffers([first, first], { names: ['a.pdf', 'b.pdf'] }))).toBe(true);
  });
});

describe('links and named destinations of the inputs', () => {
  async function linked(label: string, otherPage: number): Promise<Buffer> {
    const doc = await textPdf(label, 3);
    addNamedDestinations(doc, { chapter: otherPage, [`only-${label}`]: 0 });
    addLink(doc, 0, { Dest: doc.context.obj([doc.getPage(1).ref, 'Fit']) });
    addLink(doc, 0, { A: doc.context.obj({ S: 'GoTo', D: doc.context.obj([doc.getPage(2).ref, 'Fit']) }) });
    addLink(doc, 0, { A: doc.context.obj({ S: 'GoTo', D: PDFString.of('chapter') }) });
    addLink(doc, 0, { Dest: PDFString.of(`only-${label}`) });
    addLink(doc, 0, { A: doc.context.obj({ S: 'URI', URI: PDFString.of('https://example.com/x') }) });
    return bytesOf(doc);
  }

  it('points the links of each input at the copied pages of that input', async () => {
    const doc = await mergedDocument([await linked('A', 2), await linked('B', 1)]);
    expect(readLinks(doc, 0)).toEqual([
      { subtype: 'Link', page: 1 },
      { subtype: 'Link', page: 2 },
      { subtype: 'Link', page: 2 },
      { subtype: 'Link', page: 0 },
      { subtype: 'Link', page: -1, uri: 'https://example.com/x' },
    ]);
    // The second input starts at page 3; "chapter" is page index 1 of it, whatever the first input called "chapter".
    expect(readLinks(doc, 3)).toEqual([
      { subtype: 'Link', page: 4 },
      { subtype: 'Link', page: 5 },
      { subtype: 'Link', page: 4 },
      { subtype: 'Link', page: 3 },
      { subtype: 'Link', page: -1, uri: 'https://example.com/x' },
    ]);
  });

  it('does not add a page that is not in the document for a link destination', async () => {
    const doc = await mergedDocument([await linked('A', 2), await linked('B', 1)]);
    expect(doc.getPageCount()).toBe(6);
    const pageObjects = [...doc.context.enumerateIndirectObjects()].filter(
      ([, object]) => object instanceof PDFDict && object.get(PDFName.of('Type')) === PDFName.of('Page')
    );
    expect(pageObjects).toHaveLength(6);
  });

  it('merges the named destinations of the inputs and keeps the first one when a name is taken', async () => {
    const doc = await mergedDocument([await linked('A', 2), await linked('B', 1)]);
    expect(readNamedDestinations(doc)).toEqual({ chapter: 2, 'only-A': 0, 'only-B': 3 });
  });

  it('merges the named destinations of the old /Dests dictionary', async () => {
    const source = await textPdf('A', 2);
    source.catalog.set(PDFName.of('Dests'), source.context.obj({ old: source.context.obj([source.getPage(1).ref, 'Fit']) }));
    const doc = await mergedDocument([await bytesOf(await textPdf('B', 1)), await bytesOf(source)]);
    expect(readNamedDestinations(doc)).toEqual({ old: 2 });
  });

  it.skipIf(qpdfMissing)('writes a file that qpdf --check accepts', async () => {
    expect(qpdfCheckPasses(await mergePdfBuffers([await linked('A', 2), await linked('B', 1)]))).toBe(true);
  });
});

describe('page labels of the inputs', () => {
  it('merges the labels with the offset of each input and numbers an input that has none in decimals', async () => {
    const first = await textPdf('A', 3);
    addPageLabels(first, [[0, { S: 'r' }], [2, { S: 'D', St: 1 }]]);
    const second = await textPdf('B', 2);
    const third = await textPdf('C', 2);
    addPageLabels(third, [[0, { S: 'D', P: PDFString.of('B-') }]]);
    const doc = await mergedDocument([await bytesOf(first), await bytesOf(second), await bytesOf(third)]);
    expect(readPageLabels(doc)).toEqual([
      [0, { S: 'r', St: 1 }],
      [2, { S: 'D', St: 1 }],
      [3, { S: 'D', St: 4 }],
      [5, { S: 'D', P: 'B-', St: 1 }],
    ]);
  });

  it('keeps a label that continues the numbering of the input from a page after the first', async () => {
    const first = await textPdf('A', 4);
    addPageLabels(first, [[0, { S: 'D', St: 5 }]]);
    const second = await textPdf('B', 2);
    addPageLabels(second, [[0, { S: 'a' }]]);
    const doc = await mergedDocument([await bytesOf(first), await bytesOf(second)]);
    expect(readPageLabels(doc)).toEqual([
      [0, { S: 'D', St: 5 }],
      [4, { S: 'a', St: 1 }],
    ]);
  });

  it('writes no labels when no input has any', async () => {
    const doc = await mergedDocument([await bytesOf(await textPdf('A', 1)), await bytesOf(await textPdf('B', 1))]);
    expect(doc.catalog.has(PDFName.of('PageLabels'))).toBe(false);
  });
});

describe('document information and tagged structure', () => {
  it('takes the title, the author and the other information of the first input', async () => {
    const first = await textPdf('A', 1);
    first.setTitle('First title');
    first.setAuthor('First author');
    first.setSubject('First subject');
    const second = await textPdf('B', 1);
    second.setTitle('Second title');
    const doc = await PDFDocument.load(await mergePdfBuffers([await bytesOf(first), await bytesOf(second)]), { updateMetadata: false });
    expect(doc.getTitle()).toBe('First title');
    expect(doc.getAuthor()).toBe('First author');
    expect(doc.getSubject()).toBe('First subject');
  });

  it('leaves no /StructParents on a page and no /StructParent on an annotation when the structure tree is not carried over', async () => {
    const source = await textPdf('A', 2);
    source.getPage(0).node.set(PDFName.of('StructParents'), PDFNumber.of(0));
    addLink(source, 0, { StructParent: PDFNumber.of(1), Dest: source.context.obj([source.getPage(1).ref, 'Fit']) });
    const doc = await mergedDocument([await bytesOf(source), await bytesOf(await textPdf('B', 1))]);
    expect(doc.getPage(0).node.has(PDFName.of('StructParents'))).toBe(false);
    const annots = lookupArray(doc, doc.getPage(0).node.get(PDFName.of('Annots')));
    const link = lookupDict(doc, annots?.get(0));
    expect(link?.has(PDFName.of('StructParent'))).toBe(false);
    expect(doc.catalog.has(PDFName.of('StructTreeRoot'))).toBe(false);
  });

  it('keeps the page content and the page order of the plain merge', async () => {
    const doc = await mergedDocument([await bytesOf(await textPdf('A', 2)), await bytesOf(await textPdf('B', 2))]);
    expect(doc.getPages().map((page) => page.getWidth())).toEqual([300, 301, 300, 301]);
  });
});
