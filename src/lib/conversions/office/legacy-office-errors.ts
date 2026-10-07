import { ConversionFailedError } from '../../types';

const MALFORMED_STATUS = 400;
const ENCRYPTED_STATUS = 422;

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

/** A legacy Office file is encrypted or password protected, so its text cannot be read. Maps to HTTP 422. */
export class EncryptedOfficeDocumentError extends ConversionFailedError {
  readonly status = ENCRYPTED_STATUS;

  constructor(message: string) {
    super(message);
    this.name = 'EncryptedOfficeDocumentError';
  }
}
