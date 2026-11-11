/** The bounds the HTTP adapters (WebDAV, Azure Blob, GCS) put on the answers they read. Their own module so a test can shorten them. */

/** An error document or a metadata answer is small; a longer body is cut so a hostile endpoint cannot fill memory. */
export const ADAPTER_BODY_CAP_BYTES = 64 * 1024;

/** The whole time an error or metadata body may take to arrive, so a body that trickles in does not hold the request. */
export const ADAPTER_RESPONSE_TIMEOUT_MS = 30_000;

/** The time the endpoint has to start its answer once the request is sent. */
export const ADAPTER_HEADERS_TIMEOUT_MS = 30_000;
