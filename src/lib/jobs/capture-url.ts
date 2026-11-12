/**
 * What can be said of the address of a website capture from its text alone, without asking a name server: it is an http or https URL
 * with no credentials and on a web port (80 or 443). The graph validator refuses what fails this at submission; the capture itself
 * (src/lib/capture/website-capture.ts) goes on to check that the host is public, and the gate checks every request after that.
 */

const MAX_URL_CHARS = 8192;
const WEB_PORTS: ReadonlySet<string> = new Set(['', '80', '443']);

/** Why `raw` cannot be captured, or undefined when its text is an address that may be. */
export function captureUrlProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return 'A website capture needs the "url" of the page.';
  if (raw.length > MAX_URL_CHARS) return `The URL is longer than ${MAX_URL_CHARS} characters.`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'The "url" is not a valid URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `The URL scheme "${url.protocol}" cannot be captured; only http and https pages can.`;
  if (url.username !== '' || url.password !== '') return 'A URL with credentials in it cannot be captured.';
  if (!WEB_PORTS.has(url.port)) return `Port ${url.port} cannot be captured; only the web ports 80 and 443 can.`;
  return undefined;
}
