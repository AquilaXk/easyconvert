import { isAvif, readAvifColour } from './avif-colour';
import { type Cicp, readPngCicp } from './cicp';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** The `cICP` chunk of a PNG or the colour description of an AVIF, or null for any other file or an untagged one. */
export function readStillCicp(buffer: Buffer): Cicp | null {
  if (buffer.length >= PNG_MAGIC.length && buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return readPngCicp(buffer);
  if (isAvif(buffer)) return readAvifColour(buffer);
  return null;
}
