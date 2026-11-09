/** How long a download URL stays valid after the click: a browser may read the blob some time after the link is followed. */
const REVOKE_DELAY_MS = 60_000;

/**
 * Saves `blob` as a file called `filename`. The link is attached to the page while it is clicked, as Firefox and Safari follow
 * only an attached link, and the URL is freed after `REVOKE_DELAY_MS`, not in the same tick, which would cancel the download.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}
