import { CFBF_MAX_FILE_BYTES } from '../../compound-file-kind';

/** Largest legacy Office file (compound file or RTF) the readers accept; everything is held in memory while parsing. A compound file is bounded by `parseCfbf` itself. */
export const LEGACY_OFFICE_MAX_INPUT_BYTES = CFBF_MAX_FILE_BYTES;
