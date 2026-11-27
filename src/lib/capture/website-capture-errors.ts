import { ConversionFailedError } from '../types';
import type { ConversionRefusalCode } from '../refusal-codes';

/**
 * A website capture asked for an address that is not a public web address: a scheme other than http and https, credentials in the
 * URL, a port other than 80 and 443, or a host that is private, loopback, link-local or otherwise internal (of the address that was asked
 * for: a hop of the page's own navigation is a failed load, `CaptureFailedError`, so that a redirect cannot probe internal names). The
 * request is understood and refused: 422.
 */
export class CaptureTargetBlockedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'capture_target_blocked';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'CaptureTargetBlockedError';
  }
}

/**
 * Website capture is switched off on this server (`CAPTURE_WEBSITE_ENABLED=false`, on by default): the request is understood and refused before
 * anything is reserved, and a worker that has it off refuses the node the same way: 422.
 */
export class CaptureUnavailableError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'capture_unavailable';
  readonly status = 422;
  constructor(message = 'Website capture is not enabled on this server.') {
    super(message);
    this.name = 'CaptureUnavailableError';
  }
}

/** The page could not be loaded or drawn (an address that does not answer, a certificate the browser refuses, a page that crashes it): 422. */
export class CaptureFailedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'capture_failed';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'CaptureFailedError';
  }
}
