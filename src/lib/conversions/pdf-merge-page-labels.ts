/*
 * The page labels of the inputs of a merge, translated from qpdf (https://github.com/qpdf/qpdf), tag v12.4.2, commit
 * 4eba95899886e851cc41d76886483b347612f2a8 (Apache-2.0, Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2026 Jay Berkenbilt and Manfred Holger): `QPDFPageLabelDocumentHelper::getLabelForPage` and
 * `getLabelsForPageRange` (libqpdf/QPDFPageLabelDocumentHelper.cc, SHA-256 4c8aa942...b163ad), and the use `QPDFJob::handlePageSpecs` makes of them
 * (libqpdf/QPDFJob.cc, SHA-256 beab92b2...2ff2c8): when any input has labels, the labels of every input are carried over with the offset of its
 * first page in the output, and the result is the /Nums of a new /PageLabels.
 *
 * The structure, the names (in camelCase), the branches and the comments are qpdf's. qpdf reads the number tree with its own tree class
 * (libqpdf/NNTree.cc); `readNumberTree` below is a plain walk of /Nums and /Kids written for this file.
 * Changes for this repository are in other files and other commits, each with its reason in its message.
 */
import { PDFArray, PDFDict, PDFNumber } from 'pdf-lib';
import type { PDFContext, PDFDocument, PDFObject } from 'pdf-lib';
import { arrayAt, dictAt, name, numberAt } from './pdf-merge-objects';

/** Nodes of a number tree one input may have. */
const MAX_NUMBER_TREE_NODES = 100_000;

/** A label dictionary: `/S` the numbering style, `/P` the prefix, `/St` the number of the first page of the range. */
interface PageLabel {
  style?: PDFObject;
  prefix?: PDFObject;
  start?: number;
}

/** The entries of a number tree, in the order of their keys. */
function readNumberTree(context: PDFContext, root: PDFDict): Array<[number, PDFObject]> {
  const entries: Array<[number, PDFObject]> = [];
  const seen = new Set<PDFDict>();
  const stack = [root];
  while (stack.length > 0 && seen.size < MAX_NUMBER_TREE_NODES) {
    const node = stack.pop() as PDFDict;
    if (seen.has(node)) continue;
    seen.add(node);
    const nums = arrayAt(context, node.get(name('Nums')));
    for (let at = 0; nums && at + 1 < nums.size(); at += 2) {
      const key = numberAt(context, nums.get(at));
      if (key !== undefined) entries.push([key, nums.get(at + 1)]);
    }
    const kids = arrayAt(context, node.get(name('Kids')));
    for (let at = 0; kids && at < kids.size(); at += 1) {
      const kid = dictAt(context, kids.get(at));
      if (kid) stack.push(kid);
    }
  }
  return entries.sort(([left], [right]) => left - right);
}

function readLabel(context: PDFContext, value: PDFObject): PageLabel | undefined {
  const dict = dictAt(context, value);
  if (!dict) return undefined;
  const style = dict.get(name('S'));
  const prefix = dict.get(name('P'));
  return {
    style: style === undefined ? undefined : context.lookup(style),
    prefix: prefix === undefined ? undefined : context.lookup(prefix),
    start: numberAt(context, dict.get(name('St'))),
  };
}

/** The labels of one input, as `QPDFPageLabelDocumentHelper` holds them. */
export class SourcePageLabels {
  private constructor(
    private readonly labels: Array<[number, PageLabel]>,
    readonly pageCount: number
  ) {}

  /** The labels of `source`, or `undefined` when it has no /PageLabels (qpdf: `hasPageLabels`). */
  static of(source: PDFDocument): SourcePageLabels | undefined {
    const root = dictAt(source.context, source.catalog.get(name('PageLabels')));
    if (!root) return undefined;
    const labels: Array<[number, PageLabel]> = [];
    for (const [index, value] of readNumberTree(source.context, root)) {
      const label = readLabel(source.context, value);
      if (label) labels.push([index, label]);
    }
    return new SourcePageLabels(labels, source.getPageCount());
  }

  /** The labels of an input that has none: every page takes the fabricated label. */
  static none(pageCount: number): SourcePageLabels {
    return new SourcePageLabels([], pageCount);
  }

  private hasIndex(pageIndex: number): boolean {
    return this.labels.some(([index]) => index === pageIndex);
  }

  /** `getLabelForPage`: the label of the page, with the number it has there, or `undefined` when no range starts at or before it. */
  labelForPage(pageIndex: number): PageLabel | undefined {
    let found: [number, PageLabel] | undefined;
    for (const entry of this.labels) {
      if (entry[0] <= pageIndex) found = entry;
    }
    if (!found) return undefined;
    const [offsetFrom, label] = found;
    return { style: label.style, prefix: label.prefix, start: (label.start ?? 1) + (pageIndex - offsetFrom) };
  }

  /**
   * `getLabelsForPageRange`: appends to `newLabels` (page index, label, page index, label, ...) the labels of the pages `startIdx` to
   * `endIdx` of this input as they number from `newStartIdx` in the output.
   */
  getLabelsForPageRange(startIdx: number, endIdx: number, newStartIdx: number, newLabels: Array<number | PageLabel>): void {
    // Start off with a suitable label for the first page. For every remaining page, if that page has an explicit entry, copy it. Otherwise,
    // let the subsequent page just sequence from the prior entry. If there is no entry for the first page, fabricate one that would match
    // how the page would look in a new file in which it also didn't have an explicit label.
    const label = this.labelForPage(startIdx) ?? fabricatedLabel(newStartIdx);
    // See if the new label is redundant based on the previous entry in the vector. If so, don't add it.
    if (!isRedundant(newLabels, label, newStartIdx)) newLabels.push(newStartIdx, label);
    const idxOffset = newStartIdx - startIdx;
    for (let index = startIdx + 1; index <= endIdx; index += 1) {
      const explicit = this.hasIndex(index) ? this.labelForPage(index) : undefined;
      if (explicit) newLabels.push(index + idxOffset, explicit);
    }
  }
}

/** The label of a page that has none, in a file whose other pages have labels: decimal numbers from the position of the page. */
function fabricatedLabel(newStartIdx: number): PageLabel {
  return { style: name('D'), start: 1 + newStartIdx };
}

function isRedundant(newLabels: Array<number | PageLabel>, label: PageLabel, newStartIdx: number): boolean {
  if (newLabels.length < 2) return false;
  const last = newLabels[newLabels.length - 1];
  const lastIdx = newLabels[newLabels.length - 2];
  if (typeof lastIdx !== 'number' || typeof last === 'number') return false;
  if (String(label.style) !== String(last.style) || String(label.prefix) !== String(last.prefix)) return false;
  if (label.start === undefined || last.start === undefined) return false;
  return label.start - last.start === newStartIdx - lastIdx;
}

function labelDictionary(context: PDFContext, label: PageLabel): PDFDict {
  const dict = PDFDict.withContext(context);
  if (label.style !== undefined) dict.set(name('S'), label.style);
  if (label.prefix !== undefined) dict.set(name('P'), label.prefix);
  if (label.start !== undefined) dict.set(name('St'), PDFNumber.of(label.start));
  return dict;
}

/** The page labels of the output: those of every input, kept when any input has some. */
export class PageLabelMerge {
  private readonly inputs: Array<{ labels?: SourcePageLabels; pageCount: number }> = [];

  addInput(source: PDFDocument): void {
    this.inputs.push({ labels: SourcePageLabels.of(source), pageCount: source.getPageCount() });
  }

  finish(context: PDFContext, catalog: PDFDict): void {
    if (!this.inputs.some((input) => input.labels)) return;
    const newLabels: Array<number | PageLabel> = [];
    let outPageNumber = 0;
    for (const { labels, pageCount } of this.inputs) {
      if (pageCount === 0) continue;
      const range = labels ?? SourcePageLabels.none(pageCount);
      range.getLabelsForPageRange(0, pageCount - 1, outPageNumber, newLabels);
      outPageNumber += pageCount;
    }
    const nums = PDFArray.withContext(context);
    newLabels.forEach((entry) => nums.push(typeof entry === 'number' ? PDFNumber.of(entry) : labelDictionary(context, entry)));
    catalog.set(name('PageLabels'), context.obj({ Nums: nums }));
  }
}
