import { FORMAT_REGISTRY } from '../registry';
import type { FormatDefinition } from '../types';

export const ALTO_SNIFF_BYTES = 4096;
const ALTO_PREAMBLE = /^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i;
const ALTO_ROOT_ELEMENT = /^<(?:[A-Za-z_][\w.-]*:)?alto(?=[\s/>])/i;

/** True when the bounded prefix of an XML file opens an `<alto>` root element (ALTO 2.x–4.x OCR layout XML). */
export function isAltoXmlPrefix(bytes: Uint8Array): boolean {
  const slice = bytes.length > ALTO_SNIFF_BYTES ? bytes.subarray(0, ALTO_SNIFF_BYTES) : bytes;
  const text = Buffer.from(slice).toString('utf8').replace(/^\uFEFF/, '');
  const body = text.replace(ALTO_PREAMBLE, '');
  return ALTO_ROOT_ELEMENT.test(body.slice(0, 128));
}

/**
 * Promotes an implicitly `.xml`-detected source to `FORMAT_REGISTRY.alto` when the requested target belongs to ALTO's
 * target set (`txt`, `html`, `pdf`, `hocr`, `alto`) and the first 4 KiB open an `<alto>` root element.
 */
export function promoteAltoXmlSource(
  sourceDef: FormatDefinition | undefined,
  explicitSourceFormat: string | undefined,
  targetFormat: string | undefined,
  prefixBytes: Uint8Array | undefined
): FormatDefinition | undefined {
  if (explicitSourceFormat || sourceDef?.id !== 'xml' || !targetFormat || !prefixBytes) return sourceDef;
  const cleanTarget = targetFormat.toLowerCase().replace(/^\./, '').trim();
  if (!FORMAT_REGISTRY.alto.targetFormats.includes(cleanTarget)) return sourceDef;
  return isAltoXmlPrefix(prefixBytes) ? FORMAT_REGISTRY.alto : sourceDef;
}
