/** A presigned part-upload URL is good for 15 minutes; no route hands out a longer-lived one. */
export const PART_URL_TTL_SECONDS = 15 * 60;
/** A presigned download URL is a bearer capability for the object, so it lives only as long as a download needs. */
export const DOWNLOAD_PRESIGN_MAX_SECONDS = 15 * 60;
