/*
 * The named destinations of the inputs of a merge and the links that name them, after pypdf (https://github.com/py-pdf/pypdf), tag 7.1.0,
 * commit 1e3e7e37af4dd1da866010def52dafec3f38e67d (BSD-3-Clause, Copyright (c) 2006-2008 Mathieu Fenniak and other contributors), file
 * pypdf/_writer.py (SHA-256 ed869929...8c38d2): `PdfWriter._merge__process_named_dests` (lines 2924 to 2959, the destinations of an input are
 * added to the destinations of the output unless the output has the name), `PdfWriter._get_cloned_page` (the page a destination names is
 * the copy of that page) and `PdfWriter._insert_filtered_annotations` (a link whose destination is a name is kept when the name is one of
 * the output's, a link whose destination page is not in the output is dropped).
 *
 * The behaviour is pypdf's. The code is not a line-by-line translation: pypdf keeps the translation of object numbers inside the reader, and
 * here the copier of pdf-merge-object-copier.ts translates the pages. Where pypdf keeps a link that names a destination of the output, whatever
 * input that destination came from, this file resolves the name in the input of the link and writes the destination itself into the link, so a
 * name that two inputs share cannot send a link to the other input. The licence text of pypdf (BSD-3-Clause) is in the header of
 * pdf-merge-outlines.ts and in docs/licensing.md.
 * Changes for this repository are in other files and other commits, each with its reason in its message.
 */
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { PDFContext, PDFObject, PDFPage } from 'pdf-lib';
import type { PdfObjectCopier } from './pdf-merge-object-copier';
import { arrayAt, dictAt, name, stringFromBytes } from './pdf-merge-objects';

/** Nodes of a name tree one input may have; the tree is read once. */
const MAX_NAME_TREE_NODES = 100_000;

const keyOfString = (value: PDFString | PDFHexString): string => Buffer.from(value.asBytes()).toString('latin1');
const keyOfName = (value: PDFName): string => Buffer.from(value.asBytes()).toString('latin1');

/** The named destinations of one input, from the /Dests dictionary of its catalog and from the /Dests name tree of its /Names. */
export class SourceDestinations {
  private readonly byName = new Map<string, PDFObject>();
  private readonly byString = new Map<string, PDFObject>();

  constructor(private readonly context: PDFContext, catalog: PDFDict) {
    const old = dictAt(context, catalog.get(name('Dests')));
    for (const [key, value] of old?.entries() ?? []) this.byName.set(keyOfName(key), value);
    const tree = dictAt(context, dictAt(context, catalog.get(name('Names')))?.get(name('Dests')));
    if (tree) this.readNameTree(tree);
  }

  /** The leaves of the name tree, read without recursion and without visiting a node twice. */
  private readNameTree(root: PDFDict): void {
    const seen = new Set<PDFDict>();
    const stack = [root];
    while (stack.length > 0 && seen.size < MAX_NAME_TREE_NODES) {
      const node = stack.pop() as PDFDict;
      if (seen.has(node)) continue;
      seen.add(node);
      const names = arrayAt(this.context, node.get(name('Names')));
      for (let at = 0; names && at + 1 < names.size(); at += 2) {
        const key = this.context.lookup(names.get(at));
        if (key instanceof PDFString || key instanceof PDFHexString) this.byString.set(keyOfString(key), names.get(at + 1));
      }
      const kids = arrayAt(this.context, node.get(name('Kids')));
      for (let at = 0; kids && at < kids.size(); at += 1) {
        const kid = dictAt(this.context, kids.get(at));
        if (kid) stack.push(kid);
      }
    }
  }

  get size(): number {
    return this.byName.size + this.byString.size;
  }

  /** `[page /Fit]` for a destination that is an array or a dictionary with a /D array; `undefined` for anything else. */
  explicit(value: PDFObject | undefined): PDFArray | undefined {
    const resolved = value === undefined ? undefined : this.context.lookup(value);
    if (resolved instanceof PDFArray) return resolved;
    return resolved instanceof PDFDict ? arrayAt(this.context, resolved.get(name('D'))) : undefined;
  }

  /** The destination array that a name or a string in a link or a bookmark stands for in this input. */
  resolve(reference: PDFObject | undefined): PDFArray | undefined {
    const value = reference === undefined ? undefined : this.context.lookup(reference);
    if (value instanceof PDFName) return this.explicit(this.byName.get(keyOfName(value)) ?? this.byString.get(keyOfName(value)));
    if (value instanceof PDFString || value instanceof PDFHexString) return this.explicit(this.byString.get(keyOfString(value)) ?? this.byName.get(keyOfString(value)));
    return undefined;
  }

  /** Every named destination as `[key, array]` with the key written as the bytes of the name. */
  *entries(): Generator<[string, PDFArray]> {
    for (const map of [this.byName, this.byString]) {
      for (const [key, value] of map) {
        const array = this.explicit(value);
        if (array) yield [key, array];
      }
    }
  }
}

/** Whether `destination` is an array whose first item is one of the pages in `pageTags`: the page a destination of an input names. */
export function destinationNamesPage(destination: PDFArray | undefined, pageTags: ReadonlySet<string>): boolean {
  const target = destination?.get(0);
  return target instanceof PDFRef && pageTags.has(target.tag);
}

/** The named destinations of the output: the destinations of the first input that has a name, sorted as a name tree wants them. */
export class DestinationMerge {
  private readonly destinations = new Map<string, PDFObject>();

  /** Adds each destination of `names` whose page is one of the input's pages and whose name the output does not have yet. */
  add(names: SourceDestinations, copier: PdfObjectCopier, pageTags: ReadonlySet<string>): void {
    for (const [key, array] of names.entries()) {
      if (this.destinations.has(key) || !destinationNamesPage(array, pageTags)) continue;
      this.destinations.set(key, copier.copy(array));
    }
  }

  finish(context: PDFContext, catalog: PDFDict): void {
    if (this.destinations.size === 0) return;
    const pairs: PDFObject[] = [];
    for (const key of [...this.destinations.keys()].sort()) {
      pairs.push(stringFromBytes(Buffer.from(key, 'latin1')), this.destinations.get(key) as PDFObject);
    }
    const dests = context.obj({ Names: pairs });
    catalog.set(name('Names'), context.obj({ Dests: context.register(dests) }));
  }
}

/** The link annotation's own destination: `/Dest`, or `/D` of a go-to action. */
function destinationOfLink(context: PDFContext, annotation: PDFDict): { owner: PDFDict; key: PDFName; value: PDFObject } | undefined {
  const dest = annotation.get(name('Dest'));
  if (dest !== undefined) return { owner: annotation, key: name('Dest'), value: dest };
  const action = dictAt(context, annotation.get(name('A')));
  if (action && context.lookup(action.get(name('S'))) === name('GoTo') && action.has(name('D'))) {
    return { owner: action, key: name('D'), value: action.get(name('D')) as PDFObject };
  }
  return undefined;
}

/**
 * Writes the destination that a named link stands for into the link, for each link annotation of `pages` (the copies of the pages of one
 * input): an explicit destination was already copied with its page translated, and a name is looked up in `names`, the destinations of the
 * input. A link whose name the input does not have is removed, as pypdf removes the link whose destination is not in its output.
 */
export function resolveLinkDestinations(context: PDFContext, pages: PDFPage[], names: SourceDestinations, copier: PdfObjectCopier): void {
  for (const page of pages) {
    const annotations = page.node.Annots();
    if (!annotations) continue;
    const kept: PDFObject[] = [];
    for (let at = 0; at < annotations.size(); at += 1) {
      const item = annotations.get(at);
      const annotation = dictAt(context, item);
      const target = annotation && context.lookup(annotation.get(name('Subtype'))) === name('Link') ? destinationOfLink(context, annotation) : undefined;
      const value = target ? context.lookup(target.value) : undefined;
      if (target && (value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) {
        const resolved = names.resolve(value);
        if (!resolved) continue;
        target.owner.set(target.key, copier.copy(resolved));
      }
      kept.push(item);
    }
    if (kept.length !== annotations.size()) page.node.set(name('Annots'), context.obj(kept));
  }
}
