import type { NextResponse } from 'next/server';
import { createProblemDetailsResponse } from './problem-details';
import { parseContentLength } from './request-body-limit';

/**
 * The JSON body of a job request, read as text and checked before it is parsed. A JSON text is parsed whole into objects, and a body
 * of 40 MiB of `{},` is millions of them, so the bodies of the job routes are held to a number of objects and arrays that no job needs
 * (a task graph has at most 32 nodes of a few options each), counted with `indexOf` at the speed of a memory scan.
 */

/** Most `{` and `[` characters (together) a job request's JSON text may hold. */
export const JSON_BODY_MAX_OPENERS = 4096;

const OPEN_BRACE = '{';
const OPEN_BRACKET = '[';

/** Whether `text` holds more than `limit` of the characters `{` and `[`, counted up to the limit only. */
export function hasMoreOpenersThan(text: string, limit: number): boolean {
  let count = 0;
  for (const opener of [OPEN_BRACE, OPEN_BRACKET]) {
    for (let at = text.indexOf(opener); at !== -1; at = text.indexOf(opener, at + 1)) {
      if (++count > limit) return true;
    }
  }
  return false;
}

/**
 * The text of a JSON request body, or the 413 that refuses it: a declared length over `maxBytes`, a text longer than that (a body
 * without a length is also counted by the middleware as it arrives), or more objects and arrays than `JSON_BODY_MAX_OPENERS`.
 */
export async function readBoundedJsonText(req: Request, maxBytes: number, instanceUri: string): Promise<{ text: string } | { refusal: NextResponse }> {
  const declared = parseContentLength(req.headers.get('content-length'));
  if (declared.kind === 'bytes' && declared.bytes > maxBytes) {
    return { refusal: createProblemDetailsResponse(413, `This request carries ${declared.bytes} bytes, over the ${maxBytes} this route takes as JSON.`, instanceUri) };
  }
  const text = await req.text();
  if (text.length > maxBytes) {
    return { refusal: createProblemDetailsResponse(413, `This request carries more than the ${maxBytes} bytes this route takes as JSON.`, instanceUri) };
  }
  if (hasMoreOpenersThan(text, JSON_BODY_MAX_OPENERS)) {
    return {
      refusal: createProblemDetailsResponse(
        413,
        `The JSON body holds more than ${JSON_BODY_MAX_OPENERS} objects and arrays; a job request needs far fewer.`,
        instanceUri
      ),
    };
  }
  return { text };
}

/** The parsed JSON body of a job request with its text (for a route that reads its raw text too), or the 413 above, or the 400 of a body that is not JSON. */
export async function readBoundedJson(
  req: Request,
  maxBytes: number,
  instanceUri: string
): Promise<{ text: string; value: unknown } | { refusal: NextResponse }> {
  const read = await readBoundedJsonText(req, maxBytes, instanceUri);
  if ('refusal' in read) return read;
  try {
    return { text: read.text, value: JSON.parse(read.text) };
  } catch {
    return { refusal: createProblemDetailsResponse(400, 'Invalid JSON body provided in request.', instanceUri) };
  }
}
