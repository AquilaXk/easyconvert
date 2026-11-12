import { StorageListingLimitError, StorageServiceError } from './adapters/adapter-interface';
import type { S3StorageAdapter } from './adapters/s3';
import { parseListObjectsPage } from './s3-list-xml';

/** Most ListObjectsV2 answers one listing reads; a page holds up to 1000 keys, so only a store that answers nearly empty pages gets here. */
const MAX_LIST_PAGES = 20;
const LIST_PAGE_MAX_KEYS = 1000;

export interface ListedS3File {
  key: string;
  size: number;
}

function decodeListedKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded.replaceAll('+', ' '));
  } catch {
    throw new StorageServiceError('A listing answer has a key that is not valid URL encoding', 's3', { retryable: false });
  }
}

/**
 * The files under `prefix` of the customer's bucket, by key. A key that ends in `/` is the marker of a folder and is left out.
 * More than `maxFiles` files is refused (`StorageListingLimitError`), not cut short: a listing is read until the first file past
 * the limit, so a prefix of a million keys costs one page.
 */
export async function listS3Files(adapter: S3StorageAdapter, prefix: string, maxFiles: number): Promise<ListedS3File[]> {
  const files: ListedS3File[] = [];
  let continuationToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const xml = await adapter.listObjectsXml(prefix, { maxKeys: Math.min(LIST_PAGE_MAX_KEYS, maxFiles + 1), continuationToken });
    const parsed = parseListObjectsPage(xml, decodeListedKey, (message) => new StorageServiceError(message, 's3', { retryable: false }));
    for (const object of parsed.objects) {
      if (!object.key.endsWith('/')) files.push({ key: object.key, size: object.size });
    }
    if (files.length > maxFiles) throw new StorageListingLimitError(maxFiles, 's3');
    if (!parsed.isTruncated) return files;
    continuationToken = parsed.nextContinuationToken;
  }
  throw new StorageServiceError(`The listing did not finish within ${MAX_LIST_PAGES} pages`, 's3', { retryable: false });
}
