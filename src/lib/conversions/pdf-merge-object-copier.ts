/*
 * The object copier of pdf-lib, made iterative with an explicit work stack and bounded against deep direct trees.
 *
 * Source: https://github.com/Hopding/pdf-lib, tag v1.17.1, commit 4beebbef7a261ed0be089bb1d63a5b6e28cc488a (MIT), file
 * src/core/PDFObjectCopier.ts (SHA-256 30739824...4f6131). pdf-lib is a dependency of this repository (it writes the merged file); its own
 * `copyPages` builds one of these copiers per call and keeps it private, so a reference to a page that the copier meets while it copies
 * an annotation or a destination (`/P` of a widget, the page of a `/Dest` array) is copied as a second, unreachable page. The merge needs
 * the map of the copier to point those references at the copied pages and to find the copy of a form field, so the class is here with
 * `map` and `copyOf` added, and recursive traversal replaced by an explicit heap stack with bounds on direct container nesting and
 * copied object count so deep indirect or direct trees cannot overflow the JavaScript call stack or exhaust memory.
 *
 * MIT License
 *
 * Copyright (c) 2019 Andrew Dillon
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR
 * ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH
 * THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import { PDFArray, PDFDict, PDFName, PDFPageLeaf, PDFRef, PDFStream } from 'pdf-lib';
import type { PDFContext, PDFObject } from 'pdf-lib';
import { PdfStructureError } from './pdf-values';

/**
 * Maximum inline (direct, non-indirect) container nesting copied inside one indirect object.
 * pdf-lib serializes direct containers recursively in `sizeInBytes` / `copyBytesInto`, whereas indirect `PDFRef`
 * links serialize in a flat loop; bounding direct nesting at 256 gives 8x margin over `MAX_PDF_PARSE_DEPTH` (32)
 * while stopping direct container stack bombs before serialization.
 */
export const MAX_PDF_COPY_DIRECT_DEPTH = 256;

/**
 * Maximum composite objects (`PDFDict`, `PDFArray`, `PDFStream`, `PDFPageLeaf`, `PDFRef`) copied per copier session,
 * accommodating up to `MAX_PDF_OBJECTS` (500,000) indirect objects plus inline containers.
 */
export const MAX_PDF_COPY_OBJECTS = 2_000_000;

/** Maximum `/Parent` hops walked iteratively when resolving inherited attributes of a `PDFPageLeaf`. */
const MAX_PAGE_PARENT_HOPS = 64;

export interface PdfObjectCopierOptions {
  maxDirectDepth?: number;
  maxObjects?: number;
}

interface DictFrame {
  kind: 'dict';
  entries: [PDFName, PDFObject][];
  index: number;
  target: PDFDict;
  directDepth: number;
}

interface ArrayFrame {
  kind: 'array';
  source: PDFArray;
  index: number;
  target: PDFArray;
  directDepth: number;
}

interface RefFrame {
  kind: 'ref';
  source: PDFRef;
  target: PDFRef;
}

type WorkFrame = DictFrame | ArrayFrame | RefFrame;

function resolveInheritableAttribute(page: PDFPageLeaf, key: PDFName): PDFObject | undefined {
  let current: PDFDict | undefined = page;
  const visited = new Set<PDFDict>();
  for (let depth = 0; current && !visited.has(current); depth += 1) {
    if (depth > MAX_PAGE_PARENT_HOPS) {
      throw new PdfStructureError(`PDF page tree parent chain exceeds ${MAX_PAGE_PARENT_HOPS} levels.`);
    }
    visited.add(current);
    const own = current.get(key);
    if (own !== undefined) return own;
    current = current.lookupMaybe(PDFName.of('Parent'), PDFDict);
  }
  return undefined;
}

function preparePageClone(originalPage: PDFPageLeaf): PDFPageLeaf {
  const clonedPage = originalPage.clone();
  const { InheritableEntries } = PDFPageLeaf;
  for (let idx = 0, len = InheritableEntries.length; idx < len; idx += 1) {
    const key = PDFName.of(InheritableEntries[idx]);
    const value = resolveInheritableAttribute(clonedPage, key);
    if (!clonedPage.get(key) && value) clonedPage.set(key, value);
  }
  clonedPage.delete(PDFName.of('Parent'));
  return clonedPage;
}

/**
 * PdfObjectCopier copies PDFObjects from a src context to a dest context using an explicit iterative stack.
 * Indirect references reset direct nesting depth, while inline `PDFDict` / `PDFArray` / `PDFStream` trees are
 * bounded by `MAX_PDF_COPY_DIRECT_DEPTH` and total copied objects by `MAX_PDF_COPY_OBJECTS`.
 */
export class PdfObjectCopier {
  static for = (src: PDFContext, dest: PDFContext, options?: PdfObjectCopierOptions): PdfObjectCopier =>
    new PdfObjectCopier(src, dest, options);

  private readonly src: PDFContext;
  private readonly dest: PDFContext;
  private readonly maxDirectDepth: number;
  private readonly maxObjects: number;
  private readonly traversedObjects = new Map<PDFObject, PDFObject>();
  private copiedObjects = 0;

  private constructor(src: PDFContext, dest: PDFContext, options?: PdfObjectCopierOptions) {
    this.src = src;
    this.dest = dest;
    this.maxDirectDepth = options?.maxDirectDepth ?? MAX_PDF_COPY_DIRECT_DEPTH;
    this.maxObjects = options?.maxObjects ?? MAX_PDF_COPY_OBJECTS;
  }

  /** Makes `copy` the object that `source` stands for from now on, so that a reference to `source` is copied as a reference to `copy`. */
  map(source: PDFRef, copy: PDFRef): void {
    this.traversedObjects.set(source, copy);
  }

  /** The object in the destination that `source` was copied to, if it was copied. */
  copyOf<T extends PDFObject>(source: T): T | undefined {
    return this.traversedObjects.get(source) as T | undefined;
  }

  /** Copies `object` and all reachable objects into `dest` iteratively without overflowing the call stack. */
  copy = <T extends PDFObject>(object: T): T => {
    const stack: WorkFrame[] = [];
    const root = this.allocateCopy(object, 0, stack) as T;
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.kind === 'dict') this.processDictFrame(top, stack);
      else if (top.kind === 'array') this.processArrayFrame(top, stack);
      else this.processRefFrame(top, stack);
    }
    return root;
  };

  private recordAllocation(directDepth?: number): void {
    if (directDepth !== undefined && directDepth > this.maxDirectDepth) {
      throw new PdfStructureError(`PDF object nests dictionaries or arrays deeper than ${this.maxDirectDepth} levels.`);
    }
    if (++this.copiedObjects > this.maxObjects) {
      throw new PdfStructureError(`PDF object graph exceeds ${this.maxObjects} copied objects.`);
    }
  }

  private allocateDict(originalDict: PDFDict, directDepth: number, stack: WorkFrame[], cacheKey: PDFObject): PDFDict {
    this.recordAllocation(directDepth);
    const clonedDict = originalDict.clone(this.dest);
    this.traversedObjects.set(cacheKey, clonedDict);
    stack.push({ kind: 'dict', entries: originalDict.entries(), index: 0, target: clonedDict, directDepth });
    return clonedDict;
  }

  private allocateArray(originalArray: PDFArray, directDepth: number, stack: WorkFrame[]): PDFArray {
    this.recordAllocation(directDepth);
    const clonedArray = originalArray.clone(this.dest);
    this.traversedObjects.set(originalArray, clonedArray);
    stack.push({ kind: 'array', source: originalArray, index: 0, target: clonedArray, directDepth });
    return clonedArray;
  }

  private allocateStream(originalStream: PDFStream, directDepth: number, stack: WorkFrame[]): PDFStream {
    this.recordAllocation(directDepth);
    const clonedStream = originalStream.clone(this.dest);
    this.traversedObjects.set(originalStream, clonedStream);
    stack.push({ kind: 'dict', entries: originalStream.dict.entries(), index: 0, target: clonedStream.dict, directDepth });
    return clonedStream;
  }

  private allocateRef(ref: PDFRef, stack: WorkFrame[]): PDFRef {
    this.recordAllocation();
    const newRef = this.dest.nextRef();
    this.traversedObjects.set(ref, newRef);
    stack.push({ kind: 'ref', source: ref, target: newRef });
    return newRef;
  }

  private allocateCopy(object: PDFObject, directDepth: number, stack: WorkFrame[]): PDFObject {
    const mapped = this.traversedObjects.get(object);
    if (mapped !== undefined) return mapped;
    if (object instanceof PDFPageLeaf) return this.allocateDict(preparePageClone(object), directDepth, stack, object);
    if (object instanceof PDFDict) return this.allocateDict(object, directDepth, stack, object);
    if (object instanceof PDFArray) return this.allocateArray(object, directDepth, stack);
    if (object instanceof PDFStream) return this.allocateStream(object, directDepth, stack);
    if (object instanceof PDFRef) return this.allocateRef(object, stack);
    return object.clone();
  }

  private processDictFrame(frame: DictFrame, stack: WorkFrame[]): void {
    const { entries, target, directDepth } = frame;
    const len = entries.length;
    while (frame.index < len) {
      const [key, value] = entries[frame.index];
      frame.index += 1;
      const depthBefore = stack.length;
      target.set(key, this.allocateCopy(value, directDepth + 1, stack));
      if (stack.length > depthBefore) return;
    }
    stack.pop();
  }

  private processArrayFrame(frame: ArrayFrame, stack: WorkFrame[]): void {
    const { source, target, directDepth } = frame;
    const len = source.size();
    while (frame.index < len) {
      const idx = frame.index;
      frame.index += 1;
      const depthBefore = stack.length;
      target.set(idx, this.allocateCopy(source.get(idx), directDepth + 1, stack));
      if (stack.length > depthBefore) return;
    }
    stack.pop();
  }

  private processRefFrame(frame: RefFrame, stack: WorkFrame[]): void {
    stack.pop();
    const dereferencedValue = this.src.lookup(frame.source);
    if (dereferencedValue !== undefined) {
      this.dest.assign(frame.target, this.allocateCopy(dereferencedValue, 0, stack));
    }
  }
}
