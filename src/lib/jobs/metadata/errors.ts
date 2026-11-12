import { ConversionFailedError } from '../../types';
import type { ConversionRefusalCode } from '../../refusal-codes';

/**
 * A metadata task asked to write into a file whose format cannot be written without changing more than the metadata (a picture
 * that would be encoded again, a document the program cannot keep whole). The file is intact and the request understood: 422.
 */
export class MetadataWriteUnsupportedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'metadata_write_unsupported';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'MetadataWriteUnsupportedError';
  }
}

/** A metadata task names a field the format cannot hold, or gives a field a value it cannot take: 422. */
export class MetadataFieldError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'metadata_field_invalid';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'MetadataFieldError';
  }
}
