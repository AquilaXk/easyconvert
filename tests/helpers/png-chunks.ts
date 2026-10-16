import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { serializeChunks, type Chunk } from './apng-builder';

/**
 * PNG chunks written into a PNG the image library wrote, for pictures that hold what the library cannot attach without converting
 * the samples (it moves them through a profile it is given) or cannot write at all (text). The chunk bytes come from the
 * hand-written serializer of apng-builder.ts and the profile is the file that ships as data with the PDF library.
 */

export const SRGB_PROFILE = readFileSync(path.join(__dirname, '..', '..', 'node_modules', 'pdfkit', 'js', 'data', 'sRGB_IEC61966_2_1.icc'));

/** IHDR is the first chunk: 8 bytes of signature, then 4 of length, 4 of type, 13 of data and 4 of CRC. */
const AFTER_IHDR = 8 + 25;

/** The PNG with `chunks` inserted right after IHDR. */
export function withChunksAfterHeader(png: Buffer, chunks: Chunk[]): Buffer {
  return Buffer.concat([png.subarray(0, AFTER_IHDR), serializeChunks(chunks, Buffer.alloc(0)), png.subarray(AFTER_IHDR)]);
}

/** An iCCP chunk holding the usual 3 kB sRGB profile. */
export function srgbProfileChunk(): Chunk {
  return { type: 'iCCP', data: Buffer.concat([Buffer.from('sRGB\0\0', 'latin1'), zlib.deflateSync(SRGB_PROFILE)]) };
}

/** A tEXt chunk. */
export function textChunk(keyword = 'Comment', text = 'written by the test'): Chunk {
  return { type: 'tEXt', data: Buffer.from(`${keyword}\0${text}`, 'latin1') };
}

/** An iTXt chunk holding an XMP packet, which is where a PNG keeps one. */
export function xmpChunk(packet = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></x:xmpmeta>'): Chunk {
  return { type: 'iTXt', data: Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(packet, 'utf8')]) };
}
