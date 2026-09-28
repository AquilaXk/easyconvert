import fs from 'node:fs';
import { assertNotSpoofedFile } from '../registry';

/**
 * Asserts fail-closed that initial magic bytes of a file on disk match the declared format.
 * Zero-heap: only reads up to 8192 header bytes without loading large files into memory.
 */
export function assertNotSpoofedFilePath(
  filePath: string,
  declaredExtensionOrFormatId: string,
  filename?: string
): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found on disk: "${filePath}". Operation failed closed.`);
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(8192);
    const bytesRead = fs.readSync(fd, headerBuf, 0, 8192, 0);
    const slice = bytesRead < 8192 ? headerBuf.subarray(0, bytesRead) : headerBuf;
    assertNotSpoofedFile(slice, declaredExtensionOrFormatId, filename);
  } finally {
    fs.closeSync(fd);
  }
}
