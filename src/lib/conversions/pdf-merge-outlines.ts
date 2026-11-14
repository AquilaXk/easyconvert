/*
 * The bookmarks of the inputs of a merge, after pypdf (https://github.com/py-pdf/pypdf), tag 7.1.0, commit
 * 1e3e7e37af4dd1da866010def52dafec3f38e67d (BSD-3-Clause, Copyright (c) 2006-2008 Mathieu Fenniak and other contributors), file
 * pypdf/_writer.py (SHA-256 ed869929...8c38d2): the outline part of `PdfWriter.merge` (an input with a name gets one top-level item that opens
 * its first page with the fit view, and the outline of the input goes under it), `PdfWriter._get_filtered_outline` (an item is kept when its
 * destination is a page of the output or when a kid is kept, a cycle in the outline ends the walk), `PdfWriter._clone_outline` (the title, the
 * destination or the action, the flags /F and the colour /C of an item) and `PdfWriter._insert_filtered_outline`.
 *
 * The behaviour is pypdf's. The code is not a line-by-line translation: pypdf keeps the translation of object numbers inside the reader and
 * counts items in its `TreeObject`, and here the copier of pdf-merge-object-copier.ts translates the pages and `link` below sets the
 * /Parent, /Prev, /Next, /First, /Last and /Count entries. The licence of pypdf (BSD-3-Clause) follows; pdf-merge-destinations.ts is covered
 * by it too.
 *
 * Copyright (c) 2006-2008, Mathieu Fenniak
 * Some contributions copyright (c) 2007, Ashish Kulkarni <kulkarni.ashish@gmail.com>
 * Some contributions copyright (c) 2014, Steve Witham <switham_github@mac-guyver.com>
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * * Redistributions of source code must retain the above copyright notice,
 * this list of conditions and the following disclaimer.
 * * Redistributions in binary form must reproduce the above copyright notice,
 * this list of conditions and the following disclaimer in the documentation
 * and/or other materials provided with the distribution.
 * * The name of the author may not be used to endorse or promote products
 * derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 *
 * Changes for this repository are in other files and other commits, each with its reason in its message.
 */
import { PDFDict, PDFNumber } from 'pdf-lib';
import type { PDFArray, PDFContext, PDFDocument, PDFObject, PDFRef } from 'pdf-lib';
import { destinationNamesPage } from './pdf-merge-destinations';
import type { SourceDestinations } from './pdf-merge-destinations';
import type { PdfObjectCopier } from './pdf-merge-object-copier';
import { arrayAt, dictAt, name, numberAt, textObject } from './pdf-merge-objects';

/** Levels of an outline that are copied; an outline deeper than any real one is cut here, so a crafted input cannot nest without end. */
const MAX_OUTLINE_DEPTH = 64;
/** Items of one input that are copied. */
const MAX_OUTLINE_ITEMS = 100_000;

interface OutlineNode {
  ref: PDFRef;
  dict: PDFDict;
  children: OutlineNode[];
  closed: boolean;
}

/** What `appendInput` needs of an input. */
export interface OutlineInput {
  source: PDFDocument;
  copier: PdfObjectCopier;
  pageTags: ReadonlySet<string>;
  names: SourceDestinations;
  /** The first page of the input as copied to the output. */
  firstPage?: PDFRef;
  /** The file name of the input: it becomes the top-level item of the input; without it the items of the input stand at the top. */
  title?: string;
}

export class OutlineMerge {
  private readonly top: OutlineNode[] = [];

  constructor(private readonly context: PDFContext) {}

  private node(dict: PDFDict, children: OutlineNode[], closed: boolean): OutlineNode {
    return { ref: this.context.register(dict), dict, children, closed };
  }

  /** The destination of a source item as the page and array the item opens, or the action the item runs. */
  private target(item: PDFDict, input: OutlineInput): { dest?: PDFArray; action?: PDFDict } | undefined {
    const { context } = this;
    const destination = item.get(name('Dest'));
    if (destination !== undefined) {
      const dest = arrayAt(context, destination) ?? input.names.resolve(destination);
      return dest && destinationNamesPage(dest, input.pageTags) ? { dest } : undefined;
    }
    const action = dictAt(context, item.get(name('A')));
    if (!action) return undefined;
    if (context.lookup(action.get(name('S'))) !== name('GoTo')) return { action };
    const dest = arrayAt(context, action.get(name('D'))) ?? input.names.resolve(action.get(name('D')));
    return dest && destinationNamesPage(dest, input.pageTags) ? { dest, action } : undefined;
  }

  /** `_clone_outline`: the item for a source item, in the output. */
  private cloneItem(item: PDFDict, target: { dest?: PDFArray; action?: PDFDict } | undefined, input: OutlineInput): PDFDict {
    const { copier } = input;
    const clone = PDFDict.withContext(this.context);
    clone.set(name('Title'), copier.copy(item.get(name('Title')) as PDFObject));
    if (target?.dest && target.action) {
      const action = copier.copy(target.action).clone(this.context);
      action.set(name('D'), copier.copy(target.dest));
      clone.set(name('A'), action);
    } else if (target?.dest) {
      clone.set(name('Dest'), copier.copy(target.dest));
    } else if (target?.action) {
      clone.set(name('A'), copier.copy(target.action));
    }
    for (const key of ['F', 'C']) {
      const value = item.get(name(key));
      if (value !== undefined) clone.set(name(key), copier.copy(value));
    }
    return clone;
  }

  /** `_get_filtered_outline`: the items of one level of the outline of the input and, below them, the kept items of the levels under. */
  private level(first: PDFObject | undefined, input: OutlineInput, visited: Set<PDFDict>, depth: number): OutlineNode[] {
    const nodes: OutlineNode[] = [];
    let item = dictAt(input.source.context, first);
    while (item && !visited.has(item) && visited.size < MAX_OUTLINE_ITEMS) {
      visited.add(item);
      const kids = depth < MAX_OUTLINE_DEPTH ? this.level(item.get(name('First')), input, visited, depth + 1) : [];
      if (!item.has(name('Title'))) {
        // An item with no title is not one the viewer shows; its kids stand in its place.
        nodes.push(...kids);
      } else {
        const target = this.target(item, input);
        if (target || kids.length > 0) {
          const closed = (numberAt(input.source.context, item.get(name('Count'))) ?? 0) < 0;
          nodes.push(this.node(this.cloneItem(item, target, input), kids, closed));
        }
      }
      item = dictAt(input.source.context, item.get(name('Next')));
    }
    return nodes;
  }

  /** Adds the outline of an input: under an item named for the input when it has a file name. */
  appendInput(input: OutlineInput): void {
    const outline = dictAt(input.source.context, input.source.catalog.get(name('Outlines')));
    const items = outline ? this.level(outline.get(name('First')), input, new Set(), 0) : [];
    if (input.title && input.firstPage) {
      const wrapper = PDFDict.withContext(this.context);
      wrapper.set(name('Title'), textObject(input.title));
      wrapper.set(name('Dest'), this.context.obj([input.firstPage, 'Fit']));
      this.top.push(this.node(wrapper, items, false));
    } else {
      this.top.push(...items);
    }
  }

  /** Sets /Parent, /Prev, /Next, /First, /Last and /Count of `nodes` under `parent`; returns the items a viewer shows below `parent`. */
  private link(parent: PDFRef, nodes: OutlineNode[]): number {
    let visible = 0;
    nodes.forEach((node, index) => {
      node.dict.set(name('Parent'), parent);
      if (index > 0) node.dict.set(name('Prev'), nodes[index - 1].ref);
      if (index < nodes.length - 1) node.dict.set(name('Next'), nodes[index + 1].ref);
      const below = this.link(node.ref, node.children);
      if (node.children.length > 0) {
        node.dict.set(name('First'), node.children[0].ref);
        node.dict.set(name('Last'), node.children[node.children.length - 1].ref);
        // A positive /Count is the number of items shown below an open item; a closed one holds the number it would show, negated.
        node.dict.set(name('Count'), PDFNumber.of(node.closed ? -below : below));
      }
      visible += 1 + (node.closed ? 0 : below);
    });
    return visible;
  }

  finish(catalog: PDFDict): void {
    if (this.top.length === 0) return;
    const rootRef = this.context.nextRef();
    const visible = this.link(rootRef, this.top);
    const root = this.context.obj({ Type: 'Outlines', First: this.top[0].ref, Last: this.top[this.top.length - 1].ref, Count: visible });
    this.context.assign(rootRef, root);
    catalog.set(name('Outlines'), rootRef);
  }
}
