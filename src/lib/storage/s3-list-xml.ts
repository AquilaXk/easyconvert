import { readXmlElement } from './adapters/s3';

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
