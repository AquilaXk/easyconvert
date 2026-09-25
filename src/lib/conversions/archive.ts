import JSZip from 'jszip';
import zlib from 'zlib';
import { ConversionOptions, ConversionResult } from '../types';

export async function createZipArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.zip'
): Promise<ConversionResult> {
  const zip = new JSZip();

  for (const f of files) {
    zip.file(f.filename, f.buffer);
  }

  const compressionLevel = options.compressionLevel
    ? Math.max(1, Math.min(9, options.compressionLevel))
    : 6;

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: compressionLevel,
    },
  });

  return {
    buffer: content,
    mimeType: 'application/zip',
    filename: archiveName,
    size: content.length,
  };
}

export async function extractZipArchive(
  zipBuffer: Buffer
): Promise<{ filename: string; buffer: Buffer }[]> {
  const zip = await JSZip.loadAsync(zipBuffer);
  const files: { filename: string; buffer: Buffer }[] = [];

  for (const [filename, file] of Object.entries(zip.files)) {
    if (!file.dir) {
      const buffer = await file.async('nodebuffer');
      files.push({ filename, buffer });
    }
  }

  return files;
}

export function createTarArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.tar'
): ConversionResult {
  const blocks: Buffer[] = [];

  for (const file of files) {
    const header = Buffer.alloc(512);
    // name (100)
    header.write(file.filename.slice(0, 100), 0, 100, 'ascii');
    // mode (8)
    header.write('0000644\0', 100, 8, 'ascii');
    // uid (8)
    header.write('0000000\0', 108, 8, 'ascii');
    // gid (8)
    header.write('0000000\0', 116, 8, 'ascii');
    // size (12)
    const sizeOctal = file.buffer.length.toString(8).padStart(11, '0') + '\0';
    header.write(sizeOctal, 124, 12, 'ascii');
    // mtime (12)
    const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    header.write(mtimeOctal, 136, 12, 'ascii');
    // chksum placeholder (8 spaces)
    header.write('        ', 148, 8, 'ascii');
    // typeflag (1) regular file = '0'
    header.write('0', 156, 1, 'ascii');
    // magic (6) 'ustar\0'
    header.write('ustar\0', 257, 6, 'ascii');
    // version (2) '00'
    header.write('00', 263, 2, 'ascii');

    // Calculate checksum
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    const chksumOctal = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chksumOctal, 148, 8, 'ascii');

    blocks.push(header);
    blocks.push(file.buffer);

    // Padding to 512 bytes
    const pad = (512 - (file.buffer.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }

  // End of archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  const buffer = Buffer.concat(blocks);

  return {
    buffer,
    mimeType: 'application/x-tar',
    filename: archiveName,
    size: buffer.length,
  };
}

export function extractTarArchive(tarBuffer: Buffer): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  let offset = 0;

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    // Check for end of archive (all zeros)
    if (header.every((b) => b === 0)) break;

    const rawName = header.toString('ascii', 0, 100).replace(/\0.*$/, '').trim();
    if (!rawName) break;

    const sizeStr = header.toString('ascii', 124, 135).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    const fileBuf = tarBuffer.subarray(offset, offset + size);
    files.push({ filename: rawName, buffer: Buffer.from(fileBuf) });

    const pad = (512 - (size % 512)) % 512;
    offset += size + pad;
  }

  return files;
}

export async function convertArchive(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // ZIP to TAR
  if (src === 'zip' && tgt === 'tar') {
    const files = await extractZipArchive(inputBuffer);
    const archiveFiles =
      files.length > 0 ? files : [{ filename: `${baseName}.bin`, buffer: inputBuffer }];
    return createTarArchive(archiveFiles, options, `${baseName}.tar`);
  }

  // TAR to ZIP
  if (src === 'tar' && tgt === 'zip') {
    const files = extractTarArchive(inputBuffer);
    const archiveFiles =
      files.length > 0 ? files : [{ filename: `${baseName}.bin`, buffer: inputBuffer }];
    return createZipArchive(archiveFiles, options, `${baseName}.zip`);
  }

  // ZIP or TAR to GZ
  if ((src === 'zip' || src === 'tar') && tgt === 'gz') {
    const gzipped = zlib.gzipSync(inputBuffer);
    return {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${originalFilename}.gz`,
      size: gzipped.length,
    };
  }

  // GZ to TAR or ZIP
  if (src === 'gz') {
    const uncompressed = zlib.gunzipSync(inputBuffer);
    if (tgt === 'tar') {
      return {
        buffer: uncompressed,
        mimeType: 'application/x-tar',
        filename: `${baseName}.tar`,
        size: uncompressed.length,
      };
    }
    if (tgt === 'zip') {
      return createZipArchive(
        [{ filename: baseName, buffer: uncompressed }],
        options,
        `${baseName}.zip`
      );
    }
  }

  // Target TAR from any source
  if (tgt === 'tar') {
    return createTarArchive(
      [{ filename: originalFilename, buffer: inputBuffer }],
      options,
      `${baseName}.tar`
    );
  }

  // Target GZ from any source
  if (tgt === 'gz') {
    const gzipped = zlib.gzipSync(inputBuffer);
    return {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${originalFilename}.gz`,
      size: gzipped.length,
    };
  }

  // Target ZIP from any source
  return createZipArchive(
    [{ filename: originalFilename, buffer: inputBuffer }],
    options,
    `${baseName}.zip`
  );
}

export async function convertToArchive(
  inputBuffer: Buffer,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  return createZipArchive(
    [{ filename: originalFilename, buffer: inputBuffer }],
    options,
    `${baseName}.zip`
  );
}
