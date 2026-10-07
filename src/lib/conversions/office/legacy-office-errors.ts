import { ConversionFailedError } from '../../types';

const MALFORMED_STATUS = 400;

/** The encrypted-document error lives with the other status-carrying errors so the routes can map it; re-exported for the readers. */
export { EncryptedOfficeDocumentError } from '../../types';

/**
 * A legacy Office file (Word 97-2003 binary, RTF, PowerPoint 97-2003 binary) is malformed, truncated,
 * exceeds a parsing limit, or uses a feature outside the supported subset. Maps to HTTP 400.
 */
export class LegacyOfficeFormatError extends ConversionFailedError {
  readonly status = MALFORMED_STATUS;

  constructor(message: string) {
    super(message);
    this.name = 'LegacyOfficeFormatError';
  }
}
