import JSZip from 'jszip';
import zlib from 'zlib';
import { ConversionOptions, ConversionResult } from '../types';
import { compressBzip2, decompressBzip2 } from './bzip2';

// Standard CRC32 table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer | Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function rarHeaderCrc(headerWithoutCrc: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < headerWithoutCrc.length; i++) {
    c = CRC32_TABLE[(c ^ headerWithoutCrc[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) & 0xffff;
}

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

export function createRarArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.rar'
): ConversionResult {
  const blocks: Buffer[] = [];

  // 1. Marker block (7 bytes)
  blocks.push(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

  // 2. Main archive header (type 0x73)
  const mainHeadData = Buffer.alloc(11);
  mainHeadData.writeUInt8(0x73, 0); // HEAD_TYPE
  mainHeadData.writeUInt16LE(0x0000, 1); // HEAD_FLAGS
  mainHeadData.writeUInt16LE(13, 3); // HEAD_SIZE = 2 (CRC) + 11 = 13
  mainHeadData.writeUInt16LE(0, 5); // RESERVED1
  mainHeadData.writeUInt32LE(0, 7); // RESERVED2

  const mainCrc = rarHeaderCrc(mainHeadData);
  const mainHead = Buffer.alloc(13);
  mainHead.writeUInt16LE(mainCrc, 0);
  mainHeadData.copy(mainHead, 2);
  blocks.push(mainHead);

  // 3. File headers and data for each file
  for (const file of files) {
    const filenameBuf = Buffer.from(file.filename, 'utf-8');
    const nameSize = filenameBuf.length;
    const headSize = 7 + 25 + nameSize; // 32 + nameSize

    const fileHeadData = Buffer.alloc(headSize - 2);
    fileHeadData.writeUInt8(0x74, 0); // HEAD_TYPE (FILE_HEAD)
    fileHeadData.writeUInt16LE(0x8000, 1); // HEAD_FLAGS (LHD_LONG_BLOCK: file data follows)
    fileHeadData.writeUInt16LE(headSize, 3); // HEAD_SIZE
    fileHeadData.writeUInt32LE(file.buffer.length, 5); // PACK_SIZE
    fileHeadData.writeUInt32LE(file.buffer.length, 9); // UNP_SIZE
    fileHeadData.writeUInt8(3, 13); // HOST_OS (Unix)
    fileHeadData.writeUInt32LE(crc32(file.buffer), 14); // FILE_CRC
    fileHeadData.writeUInt32LE(0x50000000, 18); // FTIME (standard DOS time)
    fileHeadData.writeUInt8(20, 22); // UNP_VER (2.0)
    fileHeadData.writeUInt8(0x30, 23); // METHOD (0x30 = STORE / uncompressed)
    fileHeadData.writeUInt16LE(nameSize, 24); // NAME_SIZE
    fileHeadData.writeUInt32LE(0x00000020, 26); // ATTR (archive file)
    filenameBuf.copy(fileHeadData, 30); // FILE_NAME

    const fileCrc = rarHeaderCrc(fileHeadData);
    const fileHead = Buffer.alloc(headSize);
    fileHead.writeUInt16LE(fileCrc, 0);
    fileHeadData.copy(fileHead, 2);

    blocks.push(fileHead);
    blocks.push(file.buffer);
  }

  // 4. End of archive block (type 0x7B)
  const endHeadData = Buffer.alloc(5);
  endHeadData.writeUInt8(0x7b, 0); // HEAD_TYPE (ENDARC_HEAD)
  endHeadData.writeUInt16LE(0x4000, 1); // HEAD_FLAGS
  endHeadData.writeUInt16LE(7, 3); // HEAD_SIZE
  const endCrc = rarHeaderCrc(endHeadData);
  const endHead = Buffer.alloc(7);
  endHead.writeUInt16LE(endCrc, 0);
  endHeadData.copy(endHead, 2);
  blocks.push(endHead);

  const buffer = Buffer.concat(blocks);
  return {
    buffer,
    mimeType: 'application/x-rar-compressed',
    filename: archiveName,
    size: buffer.length,
  };
}

export function extractRarArchive(rarBuffer: Buffer): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  if (rarBuffer.length < 14) return files;

  const isRar =
    rarBuffer[0] === 0x52 &&
    rarBuffer[1] === 0x61 &&
    rarBuffer[2] === 0x72 &&
    rarBuffer[3] === 0x21 &&
    rarBuffer[4] === 0x1a &&
    rarBuffer[5] === 0x07;

  if (!isRar) return files;

  let offset = 7;
  while (offset + 7 <= rarBuffer.length) {
    const headType = rarBuffer[offset + 2];
    const headSize = rarBuffer.readUInt16LE(offset + 5);
    if (headSize < 7 || offset + headSize > rarBuffer.length) break;

    if (headType === 0x7b) {
      break;
    }

    if (headType === 0x74 && offset + 32 <= rarBuffer.length) {
      const packSize = rarBuffer.readUInt32LE(offset + 7);
      const nameSize = rarBuffer.readUInt16LE(offset + 26);
      if (offset + 32 + nameSize <= rarBuffer.length) {
        const filename = rarBuffer.toString('utf-8', offset + 32, offset + 32 + nameSize);
        const dataOffset = offset + headSize;
        if (dataOffset + packSize <= rarBuffer.length) {
          const fileBuf = Buffer.from(rarBuffer.subarray(dataOffset, dataOffset + packSize));
          files.push({ filename, buffer: fileBuf });
        }
      }
      offset += headSize + packSize;
    } else {
      offset += headSize;
    }
  }

  return files;
}

export function create7zArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.7z'
): ConversionResult {
  const packBuffers: Buffer[] = [];
  for (const f of files) {
    packBuffers.push(f.buffer);
  }
  const packData = Buffer.concat(packBuffers);

  // Build NextHeader
  const nh: number[] = [];
  nh.push(0x01); // kHeader
  nh.push(0x04); // kMainStreamsInfo
  nh.push(0x06); // kPackInfo
  nh.push(0x00); // packPos = 0
  nh.push(files.length); // numPackStreams
  nh.push(0x09); // kSize
  for (const f of files) {
    let s = f.buffer.length;
    while (s >= 0x80) {
      nh.push((s & 0x7f) | 0x80);
      s >>>= 7;
    }
    nh.push(s & 0x7f);
  }
  nh.push(0x00); // kEnd (PackInfo)

  nh.push(0x07); // kUnpackInfo
  nh.push(0x0b); // kFolder
  nh.push(files.length); // numFolders
  nh.push(0x00); // external = 0
  for (let i = 0; i < files.length; i++) {
    nh.push(0x01); // numCoders = 1
    nh.push(0x00); // method size = 1
    nh.push(0x00); // method = Copy (0x00)
  }
  nh.push(0x0c); // kCodersUnpackSize
  for (const f of files) {
    let s = f.buffer.length;
    while (s >= 0x80) {
      nh.push((s & 0x7f) | 0x80);
      s >>>= 7;
    }
    nh.push(s & 0x7f);
  }
  nh.push(0x0a); // kCRC
  nh.push(0x01); // allAreDefined = 1
  for (const f of files) {
    const c = crc32(f.buffer);
    nh.push(c & 0xff);
    nh.push((c >>> 8) & 0xff);
    nh.push((c >>> 16) & 0xff);
    nh.push((c >>> 24) & 0xff);
  }
  nh.push(0x00); // kEnd (UnpackInfo)
  nh.push(0x00); // kEnd (MainStreamsInfo)

  nh.push(0x05); // kFilesInfo
  nh.push(files.length); // numFiles
  nh.push(0x0e); // kName
  const nameBufs: Buffer[] = [];
  for (const f of files) {
    nameBufs.push(Buffer.from(f.filename + '\0', 'utf16le'));
  }
  const allNames = Buffer.concat(nameBufs);
  let nLen = allNames.length + 1;
  while (nLen >= 0x80) {
    nh.push((nLen & 0x7f) | 0x80);
    nLen >>>= 7;
  }
  nh.push(nLen & 0x7f);
  nh.push(0x00); // external = 0
  const nhPrefix = Buffer.from(nh);
  const nhBuffer = Buffer.concat([nhPrefix, allNames, Buffer.from([0x00, 0x00])]);

  const nextHeaderOffset = packData.length;
  const nextHeaderSize = nhBuffer.length;
  const nextHeaderCrc = crc32(nhBuffer);

  const startHeader = Buffer.alloc(32);
  startHeader.write('7z\xBC\xAF\x27\x1C', 0, 6, 'binary');
  startHeader.writeUInt8(0, 6);
  startHeader.writeUInt8(4, 7);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderSize), 20);
  startHeader.writeUInt32LE(nextHeaderCrc, 28);

  const shCrc = crc32(startHeader.subarray(12, 32));
  startHeader.writeUInt32LE(shCrc, 8);

  const fullArchive = Buffer.concat([startHeader, packData, nhBuffer]);
  return {
    buffer: fullArchive,
    mimeType: 'application/x-7z-compressed',
    filename: archiveName,
    size: fullArchive.length,
  };
}

export function extract7zArchive(sevenZipBuffer: Buffer): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  if (sevenZipBuffer.length < 32) return files;

  if (
    sevenZipBuffer[0] !== 0x37 ||
    sevenZipBuffer[1] !== 0x7a ||
    sevenZipBuffer[2] !== 0xbc ||
    sevenZipBuffer[3] !== 0xaf ||
    sevenZipBuffer[4] !== 0x27 ||
    sevenZipBuffer[5] !== 0x1c
  ) {
    return files;
  }

  const nextHeaderOffset = Number(sevenZipBuffer.readBigUInt64LE(12));
  const nextHeaderSize = Number(sevenZipBuffer.readBigUInt64LE(20));
  const nhStart = 32 + nextHeaderOffset;

  if (nhStart + nextHeaderSize > sevenZipBuffer.length) return files;
  const nh = sevenZipBuffer.subarray(nhStart, nhStart + nextHeaderSize);

  // Look for kName (0x0e) in NextHeader
  let nameIdx = -1;
  for (let i = 0; i < nh.length; i++) {
    if (nh[i] === 0x0e) {
      nameIdx = i;
      break;
    }
  }

  if (nameIdx !== -1) {
    // Read names after length varint and external flag
    let idx = nameIdx + 1;
    while (idx < nh.length && (nh[idx] & 0x80) !== 0) idx++;
    idx++; // skip last varint byte
    idx++; // skip external byte (0x00)

    const rawNames = nh.subarray(idx);
    let nameOffset = 0;
    while (nameOffset + 2 <= rawNames.length) {
      let end = nameOffset;
      while (end + 2 <= rawNames.length && (rawNames[end] !== 0 || rawNames[end + 1] !== 0)) {
        end += 2;
      }
      if (end === nameOffset) break;
      const fn = rawNames.toString('utf16le', nameOffset, end);
      if (fn) {
        files.push({
          filename: fn,
          buffer: Buffer.from(sevenZipBuffer.subarray(32, 32 + nextHeaderOffset)),
        });
      }
      nameOffset = end + 2;
    }
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
  } else if (src === 'tar.bz2' || src === 'tbz2' || src === 'tbz' || src === 'bz2' || src === 'bz') {
    try {
      const uncompressed = decompressBzip2(inputBuffer);
      if (src === 'tar.bz2' || src === 'tbz2' || src === 'tbz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch {
      files = [];
    }
  } else if (src === 'rar') {
    try {
      files = extractRarArchive(inputBuffer);
    } catch {
      files = [];
    }
  } else if (src === '7z' || src === 'tar.7z') {
    try {
      files = extract7zArchive(inputBuffer);
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
    const bz2Buffer = compressBzip2(tarResult.buffer);
    return {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: bz2Buffer.length,
    };
  }

  // 3.1 Target BZ2
  if (tgt === 'bz2' || tgt === 'bz') {
    const rawToCompress = files.length === 1 ? files[0].buffer : inputBuffer;
    const bz2Buffer = compressBzip2(rawToCompress);
    return {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip2',
      filename: `${originalFilename}.${tgt}`,
      size: bz2Buffer.length,
    };
  }

  // 4. Target 7Z
  if (tgt === '7z' || tgt === 'tar.7z') {
    return create7zArchive(files, options, `${baseName}.${tgt}`);
  }

  // 5. Target RAR
  if (tgt === 'rar') {
    return createRarArchive(files, options, `${baseName}.rar`);
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
