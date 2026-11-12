import { readXmlElement, stripQuotes } from './adapters/s3';

/**
 * The document with every `<name>...</name>` entry block removed, so the paging fields that
 * surround the entries can be read without an entry-level element of the same name getting in
 * the way. Plain string search; no pattern is built from input.
 */
export function stripEntryBlocks(xml: string, names: readonly string[]): string {
  let result = xml;
  for (const name of names) {
    const open = `<${name}>`;
    const close = `</${name}>`;
    let out = '';
    let cursor = 0;
    let from = result.indexOf(open);
    while (from !== -1) {
      const end = result.indexOf(close, from);
      if (end === -1) break;
      out += result.slice(cursor, from);
      cursor = end + close.length;
      from = result.indexOf(open, cursor);
    }
    result = out + result.slice(cursor);
  }
  return result;
}

/** An open multipart upload, as ListMultipartUploads names it. */
export interface ListedUpload {
  key: string;
  uploadId: string;
}

export interface ListedUploadsPage {
  uploads: ListedUpload[];
  isTruncated: boolean;
  nextKeyMarker?: string;
  nextUploadIdMarker?: string;
}

/**
 * One page of a ListMultipartUploads answer. `decodeKey` reverses the form URL encoding of `encoding-type=url` for the keys, and
 * `malformed` makes the error of an answer that cannot be read.
 */
export function parseListMultipartUploads(
  xml: string,
  decodeKey: (encoded: string) => string,
  malformed: (message: string) => Error
): ListedUploadsPage {
  const envelope = stripEntryBlocks(xml, ['Upload']);
  const urlEncoded = readXmlElement(envelope, 'EncodingType') === 'url';
  const decode = (raw: string | undefined): string | undefined => (urlEncoded && raw !== undefined ? decodeKey(raw) : raw);
  const uploads: ListedUpload[] = [];
  const open = '<Upload>';
  const close = '</Upload>';
  let from = xml.indexOf(open);
  while (from !== -1) {
    const end = xml.indexOf(close, from);
    if (end === -1) throw malformed('ListMultipartUploads answer has an unterminated <Upload>');
    const block = xml.slice(from + open.length, end);
    const key = decode(readXmlElement(block, 'Key'));
    const uploadId = readXmlElement(block, 'UploadId');
    if (!key || !uploadId) throw malformed('ListMultipartUploads answer has an entry without a Key and an UploadId');
    uploads.push({ key, uploadId });
    from = xml.indexOf(open, end + close.length);
  }
  return {
    uploads,
    isTruncated: readXmlElement(envelope, 'IsTruncated') === 'true',
    nextKeyMarker: decode(readXmlElement(envelope, 'NextKeyMarker')),
    nextUploadIdMarker: readXmlElement(envelope, 'NextUploadIdMarker'),
  };
}

export interface ListedObject {
  key: string;
  size: number;
  etag: string;
  lastModified?: Date;
}

export interface ListObjectsPage {
  objects: ListedObject[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

function parseListedDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * One page of a ListObjectsV2 answer. `decodeKey` reverses the form URL encoding of `encoding-type=url` for the keys, and
 * `malformed` makes the error of an answer that cannot be read. A server that ignores `encoding-type` answers without
 * `<EncodingType>`; its keys are plain text.
 */
export function parseListObjectsPage(
  xml: string,
  decodeKey: (encoded: string) => string,
  malformed: (message: string) => Error
): ListObjectsPage {
  const envelope = stripEntryBlocks(xml, ['Contents']);
  const urlEncoded = readXmlElement(envelope, 'EncodingType') === 'url';
  const objects: ListedObject[] = [];
  const open = '<Contents>';
  const close = '</Contents>';
  let from = xml.indexOf(open);
  while (from !== -1) {
    const end = xml.indexOf(close, from);
    if (end === -1) {
      throw malformed('ListObjectsV2 answer has an unterminated <Contents>');
    }
    const block = xml.slice(from + open.length, end);
    const rawKey = readXmlElement(block, 'Key');
    const key = urlEncoded && rawKey !== undefined ? decodeKey(rawKey) : rawKey;
    const size = Number.parseInt(readXmlElement(block, 'Size') ?? '', 10);
    if (key === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw malformed('ListObjectsV2 answer has an entry without a valid Key and Size');
    }
    objects.push({
      key,
      size,
      etag: stripQuotes(readXmlElement(block, 'ETag')) ?? '',
      lastModified: parseListedDate(readXmlElement(block, 'LastModified')),
    });
    from = xml.indexOf(open, end + close.length);
  }
  const isTruncated = readXmlElement(envelope, 'IsTruncated') === 'true';
  const nextContinuationToken = readXmlElement(envelope, 'NextContinuationToken');
  if (isTruncated && !nextContinuationToken) {
    throw malformed('ListObjectsV2 answer is truncated but has no NextContinuationToken');
  }
  return { objects, isTruncated, nextContinuationToken };
}
