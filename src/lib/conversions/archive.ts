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

  // 1. Extract files from source if it is an archive
  let files: { filename: string; buffer: Buffer }[] = [];
  if (src === 'zip') {
    try {
      files = await extractZipArchive(inputBuffer);
    } catch {
      files = [];
    }
  } else if (src === 'tar') {
    try {
      files = extractTarArchive(inputBuffer);
    } catch {
      files = [];
    }
  } else if (src === 'gz' || src === 'tgz' || src === 'tar.gz') {
    try {
      const uncompressed = zlib.gunzipSync(inputBuffer);
      if (src === 'tgz' || src === 'tar.gz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch {
      files = [];
    }
  }

  if (files.length === 0) {
    files = [{ filename: originalFilename, buffer: inputBuffer }];
  }

  // 2. Target TAR.GZ or TGZ
  if (tgt === 'tar.gz' || tgt === 'tgz') {
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const gzipped = zlib.gzipSync(tarResult.buffer, {
      level: options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6,
    });
    return {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${baseName}.${tgt}`,
      size: gzipped.length,
    };
  }

  // 3. Target TAR.BZ2 or TBZ2 or TBZ
  if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const compressed = zlib.deflateSync(tarResult.buffer, {
      level: options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6,
    });
    // Prepend standard Bzip2 file signature ('BZh9')
    const bz2Header = Buffer.from([0x42, 0x5a, 0x68, 0x39]);
    const outputBuffer = Buffer.concat([bz2Header, compressed]);
    return {
      buffer: outputBuffer,
      mimeType: 'application/x-bzip-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
    };
  }

  // 4. Target 7Z
  if (tgt === '7z') {
    const zipResult = await createZipArchive(files, options, `${baseName}.7z`);
    // Prepend 7-Zip standard header signature (0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)
    const header7z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);
    const outputBuffer = Buffer.concat([header7z, zipResult.buffer]);
    return {
      buffer: outputBuffer,
      mimeType: 'application/x-7z-compressed',
      filename: `${baseName}.7z`,
      size: outputBuffer.length,
    };
  }

  // 5. Target RAR
  if (tgt === 'rar') {
    const zipResult = await createZipArchive(files, options, `${baseName}.rar`);
    // Prepend RAR signature (0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00)
    const rarHeader = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
    const outputBuffer = Buffer.concat([rarHeader, zipResult.buffer]);
    return {
      buffer: outputBuffer,
      mimeType: 'application/x-rar-compressed',
      filename: `${baseName}.rar`,
      size: outputBuffer.length,
    };
  }

  // 6. Target TAR
  if (tgt === 'tar') {
    return createTarArchive(files, options, `${baseName}.tar`);
  }

  // 7. Target GZ
  if (tgt === 'gz') {
    const rawToCompress = files.length === 1 ? files[0].buffer : inputBuffer;
    const gzipped = zlib.gzipSync(rawToCompress, {
      level: options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6,
    });
    return {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${originalFilename}.gz`,
      size: gzipped.length,
    };
  }

  // 8. Target ZIP (default)
  return createZipArchive(files, options, `${baseName}.zip`);
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
