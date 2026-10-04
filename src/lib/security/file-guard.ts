import fs from 'node:fs';
import { assertNotSpoofedFile, FileExtensionSpoofError, FORMAT_REGISTRY } from '../registry';

/**
 * Asserts fail-closed that initial magic bytes of a file on disk match the declared format.
 * Zero-heap: only reads up to 64 KiB (65,536 bytes) header bytes without loading large files into memory.
 */
export function assertNotSpoofedFilePath(
  filePath: string,
  declaredExtensionOrFormatId: string,
  filename?: string
): void {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found on disk: "${filePath}". Operation failed closed.`);
    throw new Error('File not found on disk. Operation failed closed.');
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    console.error(`Target path is not a regular file: "${filePath}". Operation failed closed.`);
    throw new Error('Target path is not a regular file. Operation failed closed.');
  }
  const nameStr = filename ? ` for file "${filename}"` : '';
  if (stat.size === 0) {
    const cleanExt = (declaredExtensionOrFormatId || '').toLowerCase().replace(/^\./, '').trim();
    throw new FileExtensionSpoofError(
      `File spoofing rejected${nameStr}: target file is empty (0 bytes), incompatible with declared format ".${cleanExt}". Operation failed closed.`
    );
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const maxHeaderBytes = 64 * 1024; // 64 KiB
    const headerBuf = Buffer.alloc(maxHeaderBytes);
    const bytesRead = fs.readSync(fd, headerBuf, 0, maxHeaderBytes, 0);
    const slice = bytesRead < maxHeaderBytes ? headerBuf.subarray(0, bytesRead) : headerBuf;

    let formatOrExt = declaredExtensionOrFormatId;
    if (formatOrExt.includes('/')) {
      const found = Object.values(FORMAT_REGISTRY).find((f) => f.mimeType === formatOrExt);
      if (found) {
        formatOrExt = found.extension;
      } else {
        const sub = formatOrExt.split('/').pop()?.toLowerCase().trim();
        formatOrExt = sub || 'bin';
      }
    }
    assertNotSpoofedFile(slice, formatOrExt, filename);
  } finally {
    fs.closeSync(fd);
  }
}
