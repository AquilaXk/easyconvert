/*
 * The object copier of pdf-lib, taken as it is and given two methods.
 *
 * Source: https://github.com/Hopding/pdf-lib, tag v1.17.1, commit 4beebbef7a261ed0be089bb1d63a5b6e28cc488a (MIT), file
 * src/core/PDFObjectCopier.ts (SHA-256 30739824...4f6131). pdf-lib is a dependency of this repository (it writes the merged file); its own
 * `copyPages` builds one of these copiers per call and keeps it private, so a reference to a page that the copier meets while it copies
 * an annotation or a destination (`/P` of a widget, the page of a `/Dest` array) is copied as a second, unreachable page. The merge needs
 * the map of the copier to point those references at the copied pages and to find the copy of a form field, so the class is here with
 * `map` and `copyOf` added; the rest of the file is the original's, except that the imports name `pdf-lib` instead of `src/core/...` and
 * `copy` is an `if` chain, because the code-smell gate of this repository refuses the nested conditional of the original.
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

/**
 * PDFObjectCopier copies PDFObjects from a src context to a dest context.
 * The primary use case for this is to copy pages between PDFs.
 *
 * _Copying_ an object with a PDFObjectCopier is different from _cloning_ an
 * object with its [[PDFObject.clone]] method:
 *
 * ```
 *   const src: PDFContext = ...
 *   const dest: PDFContext = ...
 *   const originalObject: PDFObject = ...
 *   const copiedObject = PDFObjectCopier.for(src, dest).copy(originalObject);
 *   const clonedObject = originalObject.clone();
 * ```
 *
 * Copying an object is equivalent to cloning it and then copying over any other
 * objects that it references. Note that only dictionaries, arrays, and streams
 * (or structures build from them) can contain indirect references to other
 * objects. Copying a PDFObject that is not a dictionary, array, or stream is
 * supported, but is equivalent to cloning it.
 */
export class PdfObjectCopier {
  static for = (src: PDFContext, dest: PDFContext): PdfObjectCopier => new PdfObjectCopier(src, dest);

  private readonly src: PDFContext;
  private readonly dest: PDFContext;
  private readonly traversedObjects = new Map<PDFObject, PDFObject>();

  private constructor(src: PDFContext, dest: PDFContext) {
    this.src = src;
    this.dest = dest;
  }

  /** Makes `copy` the object that `source` stands for from now on, so that a reference to `source` is copied as a reference to `copy`. */
  map(source: PDFRef, copy: PDFRef): void {
    this.traversedObjects.set(source, copy);
  }

  /** The object in the destination that `source` was copied to, if it was copied. */
  copyOf<T extends PDFObject>(source: T): T | undefined {
    return this.traversedObjects.get(source) as T | undefined;
  }

  copy = <T extends PDFObject>(object: T): T => {
    if (object instanceof PDFPageLeaf) return this.copyPDFPage(object) as unknown as T;
    if (object instanceof PDFDict) return this.copyPDFDict(object) as unknown as T;
    if (object instanceof PDFArray) return this.copyPDFArray(object) as unknown as T;
    if (object instanceof PDFStream) return this.copyPDFStream(object) as unknown as T;
    if (object instanceof PDFRef) return this.copyPDFIndirectObject(object) as unknown as T;
    return object.clone() as T;
  };

  private copyPDFPage = (originalPage: PDFPageLeaf): PDFPageLeaf => {
    const clonedPage = originalPage.clone();

    // Move any entries that the originalPage is inheriting from its parent
    // tree nodes directly into originalPage so they are preserved during
    // the copy.
    const { InheritableEntries } = PDFPageLeaf;
    for (let idx = 0, len = InheritableEntries.length; idx < len; idx++) {
      const key = PDFName.of(InheritableEntries[idx]);
      const value = clonedPage.getInheritableAttribute(key)!;
      if (!clonedPage.get(key) && value) clonedPage.set(key, value);
    }

    // Remove the parent reference to prevent the whole donor document's page
    // tree from being copied when we only need a single page.
    clonedPage.delete(PDFName.of('Parent'));

    return this.copyPDFDict(clonedPage) as PDFPageLeaf;
  };

  private copyPDFDict = (originalDict: PDFDict): PDFDict => {
    if (this.traversedObjects.has(originalDict)) {
      return this.traversedObjects.get(originalDict) as PDFDict;
    }

    const clonedDict = originalDict.clone(this.dest);
    this.traversedObjects.set(originalDict, clonedDict);

    const entries = originalDict.entries();

    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];
      clonedDict.set(key, this.copy(value));
    }

    return clonedDict;
  };

  private copyPDFArray = (originalArray: PDFArray): PDFArray => {
    if (this.traversedObjects.has(originalArray)) {
      return this.traversedObjects.get(originalArray) as PDFArray;
    }

    const clonedArray = originalArray.clone(this.dest);
    this.traversedObjects.set(originalArray, clonedArray);

    for (let idx = 0, len = originalArray.size(); idx < len; idx++) {
      const value = originalArray.get(idx);
      clonedArray.set(idx, this.copy(value));
    }

    return clonedArray;
  };

  private copyPDFStream = (originalStream: PDFStream): PDFStream => {
    if (this.traversedObjects.has(originalStream)) {
      return this.traversedObjects.get(originalStream) as PDFStream;
    }

    const clonedStream = originalStream.clone(this.dest);
    this.traversedObjects.set(originalStream, clonedStream);

    const entries = originalStream.dict.entries();
    for (let idx = 0, len = entries.length; idx < len; idx++) {
      const [key, value] = entries[idx];
      clonedStream.dict.set(key, this.copy(value));
    }

    return clonedStream;
  };

  private copyPDFIndirectObject = (ref: PDFRef): PDFRef => {
    const alreadyMapped = this.traversedObjects.has(ref);

    if (!alreadyMapped) {
      const newRef = this.dest.nextRef();
      this.traversedObjects.set(ref, newRef);

      const dereferencedValue = this.src.lookup(ref);
      if (dereferencedValue) {
        const cloned = this.copy(dereferencedValue);
        this.dest.assign(newRef, cloned);
      }
    }

    return this.traversedObjects.get(ref) as PDFRef;
  };
}
