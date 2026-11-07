import { getFormatByExtension } from '../registry';
import { FAMILIES, onList, type Family } from './labels';

/** The family of a conversion: the registry's category of its source format, or `unknown` for a format the registry does not name. */
export function familyOfFormat(format: unknown): Family {
  if (typeof format !== 'string') return 'unknown';
  return onList(FAMILIES, getFormatByExtension(format)?.category, 'unknown');
}
