import type JSZip from 'jszip';

/**
 * Reads one entry of a loaded archive. JSZip's `zip.file(name)` answers `null` (not `undefined`) for a missing
 * entry, so `expect(zip.file(name)).toBeDefined()` passes either way; this throws a named error instead, which
 * makes every caller assert on the entry's actual content.
 */
export class ZipEntryMissingError extends Error {
  constructor(readonly entryName: string, readonly present: string[]) {
    super(`archive has no entry "${entryName}"; entries: ${present.join(', ')}`);
    this.name = 'ZipEntryMissingError';
  }
}

export async function zipEntryText(zip: JSZip, entryName: string): Promise<string> {
  const entry = zip.file(entryName);
  if (entry === null) throw new ZipEntryMissingError(entryName, Object.keys(zip.files));
  return await entry.async('string');
}

export async function zipEntryBytes(zip: JSZip, entryName: string): Promise<Buffer> {
  const entry = zip.file(entryName);
  if (entry === null) throw new ZipEntryMissingError(entryName, Object.keys(zip.files));
  return Buffer.from(await entry.async('uint8array'));
}
