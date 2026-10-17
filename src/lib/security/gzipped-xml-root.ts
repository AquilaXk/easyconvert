import zlib from 'node:zlib';
import { gzippedXmlRootOf, xmlRootElementName } from '../format-signatures';
import { FileExtensionSpoofError } from '../types';
import { OBJECT_HEADER_BYTES } from '../storage/object-header';

/**
 * The server side half of the spoof check for gzipped XML formats (`.svgz`, `.zabw`): the registry only sees that the bytes
 * are a gzip member, and this reads the inflated head with the bounded inflate of Node's zlib to see that the document opens
 * with the element the name promises. It lives here and not in the registry because the registry is imported by the browser
 * components and the edge engines, which must not reach a decoder.
 */

/** Most bytes the head may inflate to: the size of the header window, which the root element of a real document is far inside. */
const HEAD_OUTPUT_BYTES = OBJECT_HEADER_BYTES;
/** The first slice of the member that is inflated; each further attempt doubles it. */
const FIRST_SLICE_BYTES = 64;
const ERR_BUFFER_TOO_LARGE = 'ERR_BUFFER_TOO_LARGE';

function isOutputOverBudget(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === ERR_BUFFER_TOO_LARGE;
}

/**
 * The most that the start of the gzip member `member` inflates to within the output budget, or undefined when its stream is
 * not valid gzip (or inflates past the budget before it yields anything). A slice that ends inside the stream gives the
 * bytes decoded so far (`Z_SYNC_FLUSH`), because the window the check reads is a prefix of the file. Growing the slice by
 * doubling finds the longest prefix whose output fits the budget, since an inflate that overruns gives nothing back.
 */
export function gunzipHead(member: Uint8Array, budget: number = HEAD_OUTPUT_BYTES): Buffer | undefined {
  let head: Buffer | undefined;
  for (let length = FIRST_SLICE_BYTES; ; length *= 2) {
    const slice = member.subarray(0, Math.min(length, member.length));
    try {
      head = zlib.gunzipSync(slice, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: budget });
    } catch (error) {
      return isOutputOverBudget(error) ? head : undefined;
    }
    if (slice.length === member.length) return head;
  }
}

/**
 * Throws a `FileExtensionSpoofError` when the name `declaredExtension` is a gzipped XML format and the gzip member in `header`
 * does not open with its root element. Any other name passes: the registry has judged it.
 */
export function assertGzippedXmlRoot(header: Uint8Array, declaredExtension: string, filename?: string): void {
  const extension = declaredExtension.toLowerCase().replace(/^\./, '').trim();
  const root = gzippedXmlRootOf(extension);
  if (root === undefined) return;
  const head = gunzipHead(header);
  if (head !== undefined && xmlRootElementName(head) === root) return;
  const nameStr = filename ? ` for file "${filename}"` : '';
  throw new FileExtensionSpoofError(
    `File spoofing rejected${nameStr}: the gzip member does not hold a <${root}> document, which declared format ".${extension}" requires. Operation failed closed.`
  );
}
