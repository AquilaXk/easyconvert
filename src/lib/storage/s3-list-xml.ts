import { declaresDtd, findXmlCloseTag, findXmlOpenTag, readXmlElement, stripQuotes } from './adapters/s3';

/**
 * The document with every `<name>...</name>` (including namespace-prefixed or attribute-carrying tags)
 * entry block removed, so the paging fields that surround the entries can be read without an entry-level
 * element of the same name getting in the way. Plain character search; no pattern is built from input.
 */
export function stripEntryBlocks(xml: string, names: readonly string[]): string {
  let result = xml;
  for (const name of names) {
    let open = findXmlOpenTag(result, name, 0);
    if (!open) continue;
    const parts: string[] = [];
    let cursor = 0;
    while (open) {
      if (open.selfClosing) {
        if (open.tagStart > cursor) parts.push(result.slice(cursor, open.tagStart));
        cursor = open.tagEnd;
      } else {
        const close = findXmlCloseTag(result, name, open.prefix, open.tagEnd);
        if (!close) break;
        if (open.tagStart > cursor) parts.push(result.slice(cursor, open.tagStart));
        cursor = close.tagEnd;
      }
      open = findXmlOpenTag(result, name, cursor);
    }
    if (cursor === 0) continue;
    if (cursor < result.length) parts.push(result.slice(cursor));
    result = parts.join('');
  }
  return result;
}

/**
 * Extracts inner XML substrings of every `<name ...>...</name>` block (supporting namespace prefixes
 * such as `<s3:Contents>` and element attributes), throwing `malformed` if an opening tag is unterminated.
 */
export function extractXmlBlocks(
  xml: string,
  name: string,
  contextLabel: string,
  malformed: (message: string) => Error
): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  let open = findXmlOpenTag(xml, name, cursor);
  while (open) {
    if (open.selfClosing) {
      blocks.push('');
      cursor = open.tagEnd;
    } else {
      const close = findXmlCloseTag(xml, name, open.prefix, open.tagEnd);
      if (!close) {
        throw malformed(`${contextLabel} answer has an unterminated <${name}>`);
      }
      blocks.push(xml.slice(open.tagEnd, close.tagStart));
      cursor = close.tagEnd;
    }
    open = findXmlOpenTag(xml, name, cursor);
  }
  return blocks;
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
  if (declaresDtd(xml)) {
    throw malformed('ListMultipartUploads answer declares a DTD');
  }
  const envelope = stripEntryBlocks(xml, ['Upload']);
  const urlEncoded = readXmlElement(envelope, 'EncodingType') === 'url';
  const decode = (raw: string | undefined): string | undefined => (urlEncoded && raw !== undefined ? decodeKey(raw) : raw);
  const uploads: ListedUpload[] = [];
  for (const block of extractXmlBlocks(xml, 'Upload', 'ListMultipartUploads', malformed)) {
    const key = decode(readXmlElement(block, 'Key'));
    const uploadId = readXmlElement(block, 'UploadId');
    if (!key || !uploadId) throw malformed('ListMultipartUploads answer has an entry without a Key and an UploadId');
    uploads.push({ key, uploadId });
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
  if (declaresDtd(xml)) {
    throw malformed('ListObjectsV2 answer declares a DTD');
  }
  const envelope = stripEntryBlocks(xml, ['Contents']);
  const urlEncoded = readXmlElement(envelope, 'EncodingType') === 'url';
  const objects: ListedObject[] = [];
  for (const block of extractXmlBlocks(xml, 'Contents', 'ListObjectsV2', malformed)) {
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
  }
  const isTruncated = readXmlElement(envelope, 'IsTruncated') === 'true';
  const nextContinuationToken = readXmlElement(envelope, 'NextContinuationToken');
  if (isTruncated && !nextContinuationToken) {
    throw malformed('ListObjectsV2 answer is truncated but has no NextContinuationToken');
  }
  return { objects, isTruncated, nextContinuationToken };
}
