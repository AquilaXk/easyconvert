/** The bounds the HTTP adapters (WebDAV, Azure Blob, GCS) and the URL import and export put on the answers they read. Their own module so a test can shorten them. */

/** An error document or a metadata answer is small; a longer body is cut so a hostile endpoint cannot fill memory. */
export const ADAPTER_BODY_CAP_BYTES = 64 * 1024;

/** The whole time an error or metadata body may take to arrive, so a body that trickles in does not hold the request. */
export const ADAPTER_RESPONSE_TIMEOUT_MS = 30_000;

/** The time the endpoint has to start its answer once the request is sent. */
export const ADAPTER_HEADERS_TIMEOUT_MS = 30_000;

/** `import/url` and `export/url`: the time the URL has to start its answer once the request is sent. */
export const URL_OPERATION_HEADERS_TIMEOUT_MS = 30_000;

/** `import/url` and `export/url`: the longest a response body may go without a byte, so a stalled transfer does not hold the job. */
export const URL_OPERATION_BODY_TIMEOUT_MS = 60_000;
