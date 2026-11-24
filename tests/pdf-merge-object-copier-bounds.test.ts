import { describe, expect, it } from 'vitest';
import { PDFArray, PDFContext, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPageLeaf, PDFRef } from 'pdf-lib';
import {
  MAX_PDF_COPY_DIRECT_DEPTH,
  MAX_PDF_COPY_OBJECTS,
  PdfObjectCopier,
} from '../src/lib/conversions/pdf-merge-object-copier';
import { PdfStructureError } from '../src/lib/conversions/pdf-values';
import { mergePdfBuffers } from '../src/lib/jobs/artifact-helpers';
import { typedFailureOf } from '../src/lib/types';
import { qpdfCheckPasses } from './helpers/encrypted-pdf-fixtures';
import { bytesOf, textPdf } from './helpers/pdf-merge-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

const qpdfMissing = skipWithoutTools('qpdf');

function buildNestedDirectDict(edgeDepth: number, leafValue = 42): { root: PDFDict; context: PDFContext } {
  const context = PDFContext.create();
  let current = context.obj({ Leaf: leafValue });
  for (let level = edgeDepth - 1; level >= 0; level -= 1) {
    const parent = PDFDict.withContext(context);
    parent.set(PDFName.of('Child'), current);
    current = parent;
  }
  return { root: current, context };
}

function buildNestedDirectArray(edgeDepth: number, leafValue = 99): { root: PDFArray; context: PDFContext } {
  const context = PDFContext.create();
  let current = context.obj([leafValue]);
  for (let level = edgeDepth - 1; level >= 0; level -= 1) {
    const parent = PDFArray.withContext(context);
    parent.push(current);
    current = parent;
  }
  return { root: current, context };
}

describe('PdfObjectCopier bounds and iterative traversal', () => {
  it('exports direct nesting and copied object caps aligned with PDF structure limits', () => {
    expect(MAX_PDF_COPY_DIRECT_DEPTH).toBe(256);
    expect(MAX_PDF_COPY_OBJECTS).toBe(2_000_000);
  });

  it('copies a 15,000-node indirect PDFRef dictionary chain and merges end-to-end without stack overflow', { timeout: 60_000 }, async () => {
    const chainLength = 15_000;
    const source = await textPdf('DeepChain', 1);
    const { context } = source;
    let tailRef = context.register(context.obj({ Step: 0, Tag: 'tail' }));
    for (let step = 1; step < chainLength; step += 1) {
      tailRef = context.register(context.obj({ Step: step, Next: tailRef }));
    }
    source.getPage(0).node.set(PDFName.of('EasyConvertDeepChain'), tailRef);
    const second = await textPdf('SecondDoc', 1);

    const dest = PDFContext.create();
    const copiedHead = PdfObjectCopier.for(context, dest).copy(tailRef);
    let cursor: unknown = copiedHead;
    let walked = 0;
    while (cursor instanceof PDFRef || cursor instanceof PDFDict) {
      const dict: PDFDict = cursor instanceof PDFRef ? dest.lookup(cursor, PDFDict) : cursor;
      const stepNum = dict.lookup(PDFName.of('Step'), PDFNumber).asNumber();
      expect(stepNum).toBe(chainLength - 1 - walked);
      walked += 1;
      const next = dict.get(PDFName.of('Next'));
      if (!next) {
        expect(dict.get(PDFName.of('Tag'))).toBe(PDFName.of('tail'));
        break;
      }
      cursor = next;
    }
    expect(walked).toBe(chainLength);

    const mergedBytes = await mergePdfBuffers([await bytesOf(source), await bytesOf(second)]);
    const mergedDoc = await PDFDocument.load(mergedBytes, { updateMetadata: false });
    expect(mergedDoc.getPageCount()).toBe(2);

    let mergedCursor: unknown = mergedDoc.getPage(0).node.get(PDFName.of('EasyConvertDeepChain'));
    let mergedWalked = 0;
    while (mergedCursor instanceof PDFRef || mergedCursor instanceof PDFDict) {
      const dict: PDFDict = mergedCursor instanceof PDFRef ? mergedDoc.context.lookup(mergedCursor, PDFDict) : mergedCursor;
      const stepNum = dict.lookup(PDFName.of('Step'), PDFNumber).asNumber();
      expect(stepNum).toBe(chainLength - 1 - mergedWalked);
      mergedWalked += 1;
      const next = dict.get(PDFName.of('Next'));
      if (!next) {
        expect(dict.get(PDFName.of('Tag'))).toBe(PDFName.of('tail'));
        break;
      }
      mergedCursor = next;
    }
    expect(mergedWalked).toBe(chainLength);

    if (!qpdfMissing) {
      expect(qpdfCheckPasses(mergedBytes)).toBe(true);
    }
  });

  it('copies a 15,000-node indirect PDFArray chain without stack overflow', () => {
    const chainLength = 15_000;
    const source = PDFContext.create();
    let tailRef = source.register(source.obj([0]));
    for (let step = 1; step < chainLength; step += 1) {
      tailRef = source.register(source.obj([step, tailRef]));
    }

    const dest = PDFContext.create();
    const copiedHead = PdfObjectCopier.for(source, dest).copy(tailRef);
    let currentRef: PDFRef | undefined = copiedHead;
    let walked = 0;
    while (currentRef) {
      const arr: PDFArray = dest.lookup(currentRef, PDFArray);
      const stepNum = arr.lookup(0, PDFNumber).asNumber();
      expect(stepNum).toBe(chainLength - 1 - walked);
      walked += 1;
      const next = arr.size() > 1 ? arr.get(1) : undefined;
      currentRef = next instanceof PDFRef ? next : undefined;
    }
    expect(walked).toBe(chainLength);
  });

  it('copies direct PDFDict and PDFArray trees up to MAX_PDF_COPY_DIRECT_DEPTH and rejects deeper trees with PdfStructureError', () => {
    const { root: okDict, context: srcDictCtx } = buildNestedDirectDict(MAX_PDF_COPY_DIRECT_DEPTH, 777);
    const destDictCtx = PDFContext.create();
    const copiedDict = PdfObjectCopier.for(srcDictCtx, destDictCtx).copy(okDict);
    let dictNode = copiedDict;
    for (let level = 0; level < MAX_PDF_COPY_DIRECT_DEPTH; level += 1) {
      dictNode = dictNode.get(PDFName.of('Child')) as PDFDict;
    }
    expect(dictNode.lookup(PDFName.of('Leaf'), PDFNumber).asNumber()).toBe(777);

    const { root: okArr, context: srcArrCtx } = buildNestedDirectArray(MAX_PDF_COPY_DIRECT_DEPTH, 888);
    const destArrCtx = PDFContext.create();
    const copiedArr = PdfObjectCopier.for(srcArrCtx, destArrCtx).copy(okArr);
    let arrNode = copiedArr;
    for (let level = 0; level < MAX_PDF_COPY_DIRECT_DEPTH; level += 1) {
      arrNode = arrNode.get(0) as PDFArray;
    }
    expect(arrNode.lookup(0, PDFNumber).asNumber()).toBe(888);

    const deepDictCases = [MAX_PDF_COPY_DIRECT_DEPTH + 1, 10_000];
    for (const depth of deepDictCases) {
      const { root: tooDeepDict, context: src } = buildNestedDirectDict(depth);
      let caught: unknown;
      try {
        PdfObjectCopier.for(src, PDFContext.create()).copy(tooDeepDict);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PdfStructureError);
      expect(caught instanceof RangeError).toBe(false);
      expect(typedFailureOf(caught)).toEqual({ status: 400, code: 'conversion_failed' });
    }

    const deepArrayCases = [MAX_PDF_COPY_DIRECT_DEPTH + 1, 10_000];
    for (const depth of deepArrayCases) {
      const { root: tooDeepArr, context: src } = buildNestedDirectArray(depth);
      let caught: unknown;
      try {
        PdfObjectCopier.for(src, PDFContext.create()).copy(tooDeepArr);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PdfStructureError);
      expect(caught instanceof RangeError).toBe(false);
      expect(typedFailureOf(caught)).toEqual({ status: 400, code: 'conversion_failed' });
    }

    const streamSrc = PDFContext.create();
    const { root: deepStreamDict } = buildNestedDirectDict(MAX_PDF_COPY_DIRECT_DEPTH);
    const stream = streamSrc.stream('BT ET', {});
    stream.dict.set(PDFName.of('Nested'), deepStreamDict);
    let streamErr: unknown;
    try {
      PdfObjectCopier.for(streamSrc, PDFContext.create()).copy(stream);
    } catch (err) {
      streamErr = err;
    }
    expect(streamErr).toBeInstanceOf(PdfStructureError);
    expect(typedFailureOf(streamErr)).toEqual({ status: 400, code: 'conversion_failed' });
  });

  it('rejects graphs exceeding maxObjects budget fail-closed with PdfStructureError', () => {
    const src = PDFContext.create();
    const container = PDFArray.withContext(src);
    for (let i = 0; i < 50; i += 1) {
      container.push(src.obj({ idx: i }));
    }

    const withinBudget = PdfObjectCopier.for(src, PDFContext.create(), { maxObjects: 51 }).copy(container);
    expect(withinBudget.size()).toBe(50);

    let overBudgetErr: unknown;
    try {
      PdfObjectCopier.for(src, PDFContext.create(), { maxObjects: 50 }).copy(container);
    } catch (err) {
      overBudgetErr = err;
    }
    expect(overBudgetErr).toBeInstanceOf(PdfStructureError);
    expect(typedFailureOf(overBudgetErr)).toEqual({ status: 400, code: 'conversion_failed' });
  });

  it('handles self-referential direct containers, indirect ref cycles, and preserves map/copyOf', () => {
    const src = PDFContext.create();
    const directDict = src.obj({ Name: 'self-dict' });
    directDict.set(PDFName.of('Self'), directDict);

    const directArr = src.obj([1]);
    directArr.set(0, directArr);

    const refA = src.nextRef();
    const refB = src.nextRef();
    const dictA = src.obj({ Name: 'A', Next: refB });
    const dictB = src.obj({ Name: 'B', Back: refA });
    src.assign(refA, dictA);
    src.assign(refB, dictB);

    const bareSelfRef = src.nextRef();
    src.assign(bareSelfRef, bareSelfRef);

    const mappedTarget = src.nextRef();
    const dest = PDFContext.create();
    const premapped = dest.nextRef();
    const copier = PdfObjectCopier.for(src, dest);
    copier.map(mappedTarget, premapped);

    const copiedDirectDict = copier.copy(directDict);
    expect(copiedDirectDict.get(PDFName.of('Self'))).toBe(copiedDirectDict);
    expect(copier.copyOf(directDict)).toBe(copiedDirectDict);

    const copiedDirectArr = copier.copy(directArr);
    expect(copiedDirectArr.get(0)).toBe(copiedDirectArr);
    expect(copier.copyOf(directArr)).toBe(copiedDirectArr);

    const copiedA = copier.copy(refA);
    expect(copier.copyOf(refA)).toBe(copiedA);
    const copiedB = copier.copyOf(refB) as PDFRef;
    expect(dest.lookup(copiedA, PDFDict).get(PDFName.of('Next'))).toBe(copiedB);
    expect(dest.lookup(copiedB, PDFDict).get(PDFName.of('Back'))).toBe(copiedA);

    const copiedBareSelf = copier.copy(bareSelfRef);
    expect(dest.lookup(copiedBareSelf)).toBe(copiedBareSelf);

    expect(copier.copy(mappedTarget)).toBe(premapped);
  });

  it('inherits PDFPageLeaf attributes iteratively, deletes /Parent on clone, stops on cyclic /Parent, and refuses runaway parent chains', () => {
    const src = PDFContext.create();
    const resources = src.obj({ Font: src.obj({ F1: PDFName.of('Helvetica') }) });
    const mediaBox = src.obj([0, 0, 500, 700]);
    const grandParent = src.obj({ Type: 'Pages', MediaBox: mediaBox });
    grandParent.set(PDFName.of('Parent'), grandParent); // cyclic ancestor must terminate safely
    const parentRef = src.register(src.obj({ Type: 'Pages', Resources: resources, Rotate: 90, Parent: grandParent }));
    const leaf = PDFPageLeaf.withContextAndParent(src, parentRef);
    leaf.delete(PDFName.of('MediaBox'));
    leaf.delete(PDFName.of('Resources'));

    const dest = PDFContext.create();
    const copiedPage = PdfObjectCopier.for(src, dest).copy(leaf);
    expect(copiedPage.has(PDFName.of('Parent'))).toBe(false);
    expect(leaf.has(PDFName.of('Parent'))).toBe(true);
    expect(copiedPage.lookup(PDFName.of('Rotate'), PDFNumber).asNumber()).toBe(90);
    expect(copiedPage.lookup(PDFName.of('MediaBox'), PDFArray).size()).toBe(4);
    expect(copiedPage.lookup(PDFName.of('Resources'), PDFDict).has(PDFName.of('Font'))).toBe(true);

    const deepParentCtx = PDFContext.create();
    let chain = deepParentCtx.obj({ Type: 'Pages' });
    for (let i = 0; i < 65; i += 1) {
      chain = deepParentCtx.obj({ Type: 'Pages', Parent: chain });
    }
    const chainRef = deepParentCtx.register(chain);
    const overDeepLeaf = PDFPageLeaf.withContextAndParent(deepParentCtx, chainRef);
    overDeepLeaf.delete(PDFName.of('Resources'));
    let parentErr: unknown;
    try {
      PdfObjectCopier.for(deepParentCtx, PDFContext.create()).copy(overDeepLeaf);
    } catch (err) {
      parentErr = err;
    }
    expect(parentErr).toBeInstanceOf(PdfStructureError);
  });
});
