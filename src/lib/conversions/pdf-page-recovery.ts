import { type PdfDict, PdfStructureError, type PdfRef, type PdfValue, isArray, isDict, isName, isRef } from './pdf-values';

/**
 * Whether pdf.js re-reads a file by scanning it after it followed the cross-reference, as `PDFDocument.checkFirstPage` and
 * `checkLastPage` decide it (mozilla/pdf.js v6.3.289, src/core/document.js; pdf.worker.mjs lines 60340-60420), by walking the page
 * tree the way `Catalog.getPageDict` (lines 41428-41519) and `getAllPageDicts` (lines 41520-41640) do. An `XRefEntryException`
 * from either walk (an entry whose offset names another object, or a reference whose generation is not the entry's) is the one
 * error that makes `XRefParseException` and the second read of the file, in which the last definition of a number wins; any
 * other error (a page tree that is not one, a count that is wrong) is swallowed or sends `checkLastPage` to the walk of the whole
 * tree.
 *
 * The walks are ported, not summarised: `getPageDict` pops the kids in order and skips a node whose `/Count` ends before the page
 * (so an empty `/Pages` node is walked past and the next kid is fetched), fetches each reference once, and fetches `/Count`,
 * `/Kids` and `/Type` when they are references. Not modelled: the first page of a linearized file, which pdf.js reads from the
 * object the linearization dictionary names before it walks the tree (`#getLinearizationPage`), and its page count (`/N`), which
 * `checkLastPage` uses for such a file; `PdfDocument` reads the file again by its other readings where the choice is uncertain.
 *
 * pdf.js bounds neither walk: it visits a reference once, but an inline dictionary of `/Kids` that is a reference to an array that
 * holds that dictionary again is pushed again for ever, and a node of N inline kids whose `/Kids` is a shared array of M more
 * costs N times M. Each walk here counts every node it pushes or pops, inline ones included, and the depth of each node, and
 * refuses the file (a structure error, not a fall back to the cross-reference's objects) past `PageWalkLimits`.
 */

/** What one walk of the page tree may do before the file is refused. */
export interface PageWalkLimits {
  /** Nodes pushed or popped, in one walk. */
  maxWork: number;
  /** Levels of nodes below the top `/Pages` node. */
  maxDepth: number;
}

/** The counting of one walk. */
class WalkMeter {
  private work = 0;

  constructor(private readonly limits: PageWalkLimits) {}

  /** Counts one push or pop of a node `depth` levels down. @throws PdfStructureError past a limit. */
  step(depth: number): void {
    if (depth > this.limits.maxDepth) throw new PdfStructureError('PDF page tree is nested too deeply.');
    if (++this.work > this.limits.maxWork) throw new PdfStructureError(`PDF page tree makes a reader visit more than ${this.limits.maxWork} nodes.`);
  }
}

/** A fetch or a walk that pdf.js fails on: `entry` for an `XRefEntryException`, otherwise a `FormatError` or another error. */
export class PageFault extends Error {
  constructor(readonly entry: boolean) {
    super(entry ? 'XRefEntryException' : 'page tree error');
  }
}

export interface PageTreeSource {
  /** `XRef.fetch`: the object a reference leads to (one step, a reference stays a reference), null for one the cross-reference does not list. @throws PageFault. */
  fetch(ref: PdfRef): PdfValue;
}

function fetchIfRef(source: PageTreeSource, value: PdfValue | undefined): PdfValue {
  return isRef(value) ? source.fetch(value) : (value ?? null);
}

/** `Catalog.getPageDict(pageIndex)`: returns when the page is found. @throws PageFault, PdfStructureError. */
function walkToPage(top: PdfDict, pagesRef: PdfValue | undefined, pageIndex: number, source: PageTreeSource, limits: PageWalkLimits): void {
  const meter = new WalkMeter(limits);
  const visited = new Set<number>();
  if (isRef(pagesRef)) visited.add(pagesRef.num);
  const toVisit: Array<{ node: PdfValue; depth: number }> = [{ node: top, depth: 0 }];
  let current = 0;
  while (toVisit.length > 0) {
    const { node, depth } = toVisit.pop() as { node: PdfValue; depth: number };
    meter.step(depth);
    if (isRef(node)) {
      if (visited.has(node.num)) throw new PageFault(false);
      visited.add(node.num);
      const object = source.fetch(node);
      if (isDict(object) && (isName(fetchIfRef(source, object.entries.get('Type')), 'Page') || !object.entries.has('Kids'))) {
        if (current === pageIndex) return;
        current++;
      } else {
        toVisit.push({ node: object, depth });
      }
      continue;
    }
    if (!isDict(node)) throw new PageFault(false);
    const count = fetchIfRef(source, node.entries.get('Count'));
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && current + count <= pageIndex) {
      current += count;
      continue;
    }
    const kids = fetchIfRef(source, node.entries.get('Kids'));
    if (isArray(kids)) {
      for (let last = kids.items.length - 1; last >= 0; last--) {
        meter.step(depth + 1);
        toVisit.push({ node: kids.items[last], depth: depth + 1 });
      }
    } else if (isName(fetchIfRef(source, node.entries.get('Type')), 'Page') || !node.entries.has('Kids')) {
      if (current === pageIndex) return;
      current++;
    } else {
      throw new PageFault(false);
    }
  }
  throw new PageFault(false);
}

/** The walk of `Catalog.getAllPageDicts` (not in recovery mode): whether it meets an `XRefEntryException` before any other error ends it. @throws PdfStructureError. */
function wholeTreeFails(top: PdfDict, pagesRef: PdfValue | undefined, source: PageTreeSource, limits: PageWalkLimits): boolean {
  const meter = new WalkMeter(limits);
  const visited = new Set<number>();
  if (isRef(pagesRef)) visited.add(pagesRef.num);
  const queue: Array<{ node: PdfDict; position: number }> = [{ node: top, position: 0 }];
  try {
    while (queue.length > 0) {
      meter.step(queue.length - 1);
      const item = queue[queue.length - 1];
      const kids = fetchIfRef(source, item.node.entries.get('Kids'));
      if (!isArray(kids)) return false;
      if (item.position >= kids.items.length) {
        queue.pop();
        continue;
      }
      const kid = kids.items[item.position];
      if (isRef(kid)) {
        if (visited.has(kid.num)) return false;
        visited.add(kid.num);
      }
      const object = fetchIfRef(source, kid);
      if (!isDict(object)) return false;
      if (!isName(fetchIfRef(source, object.entries.get('Type')), 'Page') && object.entries.has('Kids')) queue.push({ node: object, position: 0 });
      item.position++;
    }
  } catch (error) {
    if (error instanceof PageFault) return error.entry;
    throw error;
  }
  return false;
}

type Outcome = 'ok' | 'entry' | 'other';

function attempt(run: () => void): Outcome {
  try {
    run();
    return 'ok';
  } catch (error) {
    if (error instanceof PageFault) return error.entry ? 'entry' : 'other';
    throw error;
  }
}

/** Whether pdf.js, having followed the cross-reference, reads the first or the last page's way down the tree into an entry it cannot use and scans the file instead. */
export function recoversByScanning(top: PdfDict, pagesRef: PdfValue | undefined, source: PageTreeSource, limits: PageWalkLimits): boolean {
  // checkFirstPage: only an XRefEntryException matters, every other error leaves the first page unread and goes on.
  if (attempt(() => walkToPage(top, pagesRef, 0, source, limits)) === 'entry') return true;
  // checkLastPage: the page count of the top node, then the last page; an error that is not an XRefEntryException sends it to the whole tree.
  const last = attempt(() => {
    const count = fetchIfRef(source, top.entries.get('Count'));
    if (typeof count !== 'number' || !Number.isInteger(count)) throw new PageFault(false);
    if (count > 1) walkToPage(top, pagesRef, count - 1, source, limits);
  });
  return last === 'entry' || (last === 'other' && wholeTreeFails(top, pagesRef, source, limits));
}
