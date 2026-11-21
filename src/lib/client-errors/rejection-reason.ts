/*
 * A translation of `_getUnhandledRejectionError` of the global handlers integration of the Sentry browser SDK
 * (getsentry/sentry-javascript, packages/browser/src/integrations/globalhandlers.ts, commit 87d348707f2a550052342868d64b9a62968a3c51),
 * with `isPrimitive` of packages/core/src/utils/is.ts (same commit) in the form this site needs: the string parameterized by
 * the SDK is not here. The licence of the original file follows.
 *
 * MIT License
 *
 * Copyright (c) 2012 Functional Software, Inc. dba Sentry
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

function isPrimitive(wat: unknown): boolean {
  return wat === null || (typeof wat !== 'object' && typeof wat !== 'function');
}

/** The value a promise was rejected with, read out of the event of an unhandled rejection (or out of the wrapper some script made of it). */
export function getUnhandledRejectionError(error: unknown): unknown {
  if (isPrimitive(error)) {
    return error;
  }

  // dig the object of the rejection out of known event types
  try {
    type ErrorWithReason = { reason: unknown };
    // PromiseRejectionEvents store the object of the rejection under 'reason'
    // see https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
    if ('reason' in (error as ErrorWithReason)) {
      return (error as ErrorWithReason).reason;
    }

    type CustomEventWithDetail = { detail: { reason: unknown } };
    // something, somewhere, (likely a browser extension) effectively casts PromiseRejectionEvents
    // to CustomEvents, moving the `promise` and `reason` attributes of the PRE into
    // the CustomEvent's `detail` attribute, since they're not part of CustomEvent's spec
    // see https://developer.mozilla.org/en-US/docs/Web/API/CustomEvent and
    // https://github.com/getsentry/sentry-javascript/issues/2380
    if ('detail' in (error as CustomEventWithDetail) && 'reason' in (error as CustomEventWithDetail).detail) {
      return (error as CustomEventWithDetail).detail.reason;
    }
  } catch {
    // The reason could not be read: the event itself is what is left to describe.
  }

  return error;
}
