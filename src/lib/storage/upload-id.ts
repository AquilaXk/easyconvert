/** The longest upload id any storage backend hands out and accepts: the signed token of the remote backend is the longest. */
export const MAX_UPLOAD_ID_LENGTH = 4096;

/** Whether `uploadId` can be an id a store handed out: printable ASCII within the longest of them, so no junk becomes part of a key. */
export function isUploadIdShape(uploadId: unknown): uploadId is string {
  return typeof uploadId === 'string' && uploadId.length <= MAX_UPLOAD_ID_LENGTH && /^[\x21-\x7E]+$/.test(uploadId);
}
