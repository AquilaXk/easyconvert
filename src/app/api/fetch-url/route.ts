import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { fetch as undiciFetch } from 'undici';
import {
  MAX_REDIRECTS,
  validateUrlForSsrf,
  createSsrfSafeAgent,
} from '@/lib/security/ssrf';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { declaredBodyBytes, declaredOverflow, withLinkImportMeter, type DeclaredOverflow, type LinkImportMeter } from '@/lib/api-keys/anonymous-upload-budget';
import { isUnattributedAnonymous } from '@/lib/auth/anonymous-identity';
import { codedRefusal, createProblemDetailsResponse, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { deadlineErrorResponse, runUnderDeadline } from '@/lib/api/sync-deadline';
import { importDayReachedResponse, importLargerThanLeftResponse, unattributedTransferRefusal, uploadBudgetRefusalResponse } from '@/lib/api/upload-budget-response';
import { acquireSyncSlot, concurrencyLimitResponse } from '@/lib/queue/concurrency-limit';
import { currentJobDeadlineSettings } from '@/lib/queue/job-deadline';
import { formatBytes } from '@/lib/format-bytes';
import { URL_IMPORT_MAX_BYTES, maxFileBytes, planOfCaller, type Plan, type PlanCaller } from '@/lib/plan-limits';
import type { UrlImportErrorCode } from '@/lib/refusal-codes';
import { JobTimeoutError } from '@/lib/types';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<UrlImportErrorCode>;

/** How long the remote may take to send its headers on each hop; the whole import is held to the synchronous deadline. */
const HEADERS_TIMEOUT_MS = 12_000;
const MS_PER_SECOND = 1000;

/** File name extensions for the content types of a link whose name has none. */
const EXTENSIONS_BY_CONTENT_TYPE: ReadonlyArray<readonly [string, string]> = [
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['application/pdf', '.pdf'],
  ['text/csv', '.csv'],
  ['application/json', '.json'],
];

/** `filename`, with the extension of its content type when it has none (`.bin` for any other type). */
function withExtension(filename: string, contentType: string): string {
  if (filename.includes('.')) return filename;
  const known = EXTENSIONS_BY_CONTENT_TYPE.find(([type]) => contentType.includes(type));
  return filename + (known ? known[1] : '.bin');
}

/**
 * The 413 for a file past the limit of an import from a link. The limit is its own and smaller than the plan limit,
 * because the server reads the whole file before the browser has it, so the answer names both and the way to use the larger.
 */
function linkImportTooLarge(caller: PlanCaller | undefined): NextResponse {
  const error =
    `A file imported from a link may be at most ${formatBytes(URL_IMPORT_MAX_BYTES)}. ` +
    `Download it and add it from your device to convert a file of up to ${formatBytes(maxFileBytes(planOfCaller(caller)))}.`;
  return refusal(413, 'file_too_large', error);
}

/** Lets go of the body of an answer the import will not read, so the remote stops sending it. */
function discardBody(res: Response): void {
  res.body?.cancel().catch(() => undefined);
}

/** The answer of the remote after its redirects were followed, each hop checked against the SSRF rules, or the refusal. */
type RemoteAnswer = { res: Response; finalUrl: URL } | { refusal: NextResponse };

async function fetchFollowingRedirects(url: URL, ssrfAgent: ReturnType<typeof createSsrfSafeAgent>, signal: AbortSignal): Promise<RemoteAnswer> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const isValid = await validateUrlForSsrf(currentUrl);
    if (!isValid) {
      return { refusal: refusal(403, 'address_blocked', 'Requests to internal/private addresses are blocked.') };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEADERS_TIMEOUT_MS);
    let res: Response;
    try {
      res = (await undiciFetch(currentUrl.toString(), {
        dispatcher: ssrfAgent,
        signal: AbortSignal.any([controller.signal, signal]),
        redirect: 'manual',
        headers: {
          'User-Agent': 'EasyConvert-Universal-Ingestion/1.0',
        },
      })) as unknown as Response;
    } catch (fetchErr: unknown) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      if (msg.includes('SSRF blocked') || msg.includes('restricted')) {
        return { refusal: refusal(403, 'address_blocked', 'Requests to internal/private addresses are blocked.') };
      }
      throw fetchErr;
    } finally {
      clearTimeout(timeout);
    }

    if (res.status < 300 || res.status >= 400) return { res, finalUrl: currentUrl };
    discardBody(res);

    // Handle redirect manually with recursive DNS/IP validation
    const location = res.headers.get('location');
    if (!location) {
      return { refusal: refusal(502, 'redirect_without_location', `Redirect status ${res.status} missing Location header`) };
    }
    if (redirectCount === MAX_REDIRECTS) {
      return { refusal: refusal(502, 'too_many_redirects', 'Too many redirects encountered.') };
    }
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      return { refusal: refusal(502, 'invalid_redirect', 'Invalid redirect location URL.') };
    }
    if (currentUrl.protocol !== 'http:' && currentUrl.protocol !== 'https:') {
      return { refusal: refusal(400, 'unsupported_scheme', 'Only HTTP and HTTPS URLs are permitted.') };
    }
  }
  return { refusal: refusal(502, 'fetch_failed', 'Failed to fetch remote URL') };
}

/** Who imports: what the refusals of its body name. */
interface ImportCaller {
  caller: PlanCaller;
  plan: Plan;
  instanceUri: string;
}

/** The refusal of a body whose declared length is past the import limit (413) or past what the day has left (429). */
function declaredTooLarge(overflow: DeclaredOverflow, importer: ImportCaller): NextResponse {
  return overflow.kind === 'too-large'
    ? linkImportTooLarge(importer.caller)
    : importLargerThanLeftResponse(overflow.leftBytes, importer.instanceUri, importer.plan);
}

/**
 * The body of `res`, every chunk counted by `meter`, or the refusal: a declared length past the import limit or the day
 * before a byte is read, a body that passes the import limit (413), or a day that passes its budget while it is read (429).
 */
async function readBody(res: Response, meter: LinkImportMeter, importer: ImportCaller): Promise<{ buffer: Buffer } | { refusal: NextResponse }> {
  const overflow = declaredOverflow(declaredBodyBytes(res.headers), { limitBytes: URL_IMPORT_MAX_BYTES, leftBytes: meter.leftBytes });
  if (overflow) {
    discardBody(res);
    return { refusal: declaredTooLarge(overflow, importer) };
  }

  if (!res.body) {
    return { refusal: refusal(502, 'empty_body', 'Empty response body from remote server') };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const withinDay = await meter.count(value.length);
      if (meter.receivedBytes > URL_IMPORT_MAX_BYTES || !withinDay) {
        await reader.cancel();
        return { refusal: withinDay ? linkImportTooLarge(importer.caller) : importDayReachedResponse(importer.instanceUri, importer.plan) };
      }
      chunks.push(value);
    }
  } catch (streamErr: unknown) {
    await reader.cancel().catch(() => {});
    throw streamErr;
  }
  if (!(await meter.charge())) return { refusal: importDayReachedResponse(importer.instanceUri, importer.plan) };
  return { buffer: Buffer.concat(chunks) };
}

/** The imported file: its bytes, with the name the remote gave it or the last segment of its address. */
function importedFile(res: Response, finalUrl: URL, buffer: Buffer): NextResponse {
  // Determine filename
  let filename = '';
  const contentDisposition = res.headers.get('content-disposition');
  if (contentDisposition) {
    const match = /filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i.exec(contentDisposition);
    if (match && match[1]) {
      filename = decodeURIComponent(match[1]);
    }
  }

  if (!filename) {
    const pathParts = finalUrl.pathname.split('/').filter(Boolean);
    filename = pathParts[pathParts.length - 1] || 'remote_file';
  }

  const contentType = res.headers.get('content-type') || 'application/octet-stream';
  filename = withExtension(filename, contentType);

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'X-Filename': encodeURIComponent(filename),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': buffer.length.toString(),
    },
  });
}

/** Imports the file at `url`: follows its redirects, refuses an error answer, and reads the body. */
async function importFrom(
  url: URL,
  ssrfAgent: ReturnType<typeof createSsrfSafeAgent>,
  signal: AbortSignal,
  meter: LinkImportMeter,
  importer: ImportCaller
): Promise<NextResponse> {
  const answer = await fetchFollowingRedirects(url, ssrfAgent, signal);
  if ('refusal' in answer) return answer.refusal;
  const { res, finalUrl } = answer;
  if (!res.ok) {
    discardBody(res);
    return refusal(
      res.status >= 400 && res.status < 500 ? 400 : 502,
      'remote_error',
      `Remote server returned HTTP ${res.status}: ${res.statusText}`,
      { remoteStatus: res.status }
    );
  }
  const body = await readBody(res, meter, importer);
  return 'refusal' in body ? body.refusal : importedFile(res, finalUrl, body.buffer);
}

/** The 504 of an import whose remote did not send the whole file within the synchronous deadline. */
function importTimedOut(timeoutMs: number): NextResponse {
  const seconds = Math.ceil(timeoutMs / MS_PER_SECOND);
  return refusal(504, 'fetch_timeout', `The remote server did not send the whole file within ${seconds} seconds.`);
}

/** The link a request names, or the refusal of a body that names none the server may fetch. */
async function importTarget(req: NextRequest): Promise<URL | NextResponse> {
  const body = await readJsonObject(req);
  if (!body) return refusal(400, 'invalid_json', 'Invalid JSON request payload.');
  const { url } = body;
  if (!url || typeof url !== 'string') return refusal(400, 'url_required', 'URL is required.');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return refusal(400, 'invalid_url', 'Invalid URL format provided.');
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return refusal(400, 'unsupported_scheme', 'Only HTTP and HTTPS URLs are permitted.');
  }
  return parsedUrl;
}

export const POST = admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/fetch-url';

  // 1. Guard check: Authenticate API key/session or enforce the anonymous IP rate limit. An import costs no conversion
  // (QA decision of 2026-11-02): it only needs one left for the conversion that follows, and reserves none.
  const auth = await validateApiAccess(req, {
    requiredUnits: 0,
    requireUnitLeft: true,
    requiredScope: 'convert:write',
    allowAnonymous: true,
  });

  if (!auth.authorized || !auth.user) {
    return createProblemDetailsResponse(
      auth.status ?? 401,
      auth.error ?? 'Unauthorized',
      instanceUri,
      undefined,
      auth.problemType,
      authErrorHeaders(auth)
    );
  }
  const caller = auth.user;

  // 2. What bounds an import instead of the conversion count (docs/policy-decisions.md, entries 15 and 137): a conversion
  // slot held until the request ends, the caller's daily byte budget, and the synchronous deadline. Visitors no proxy
  // attributes would share one budget, so they are refused as their uploads are.
  if (isUnattributedAnonymous(caller.id)) return unattributedTransferRefusal(instanceUri);
  const slot = await acquireSyncSlot(caller.id, caller.tier);
  if (!slot.granted) return concurrencyLimitResponse(slot.limit, instanceUri);

  const ssrfAgent = createSsrfSafeAgent();
  try {
    const target = await importTarget(req);
    if (!(target instanceof URL)) return target;
    const importer: ImportCaller = { caller, plan: planOfCaller(caller), instanceUri };
    // The whole import, headers and body, runs under the synchronous deadline (SYNC_DEADLINE_MAX_MS). An import that
    // ended is charged before the answer; one cut off is charged once it has stopped reading, without holding the answer.
    const { syncMaxMs } = currentJobDeadlineSettings();
    const imported = await runUnderDeadline(req, syncMaxMs, (limits) =>
      withLinkImportMeter({ owner: caller.id, plan: importer.plan }, (meter) => importFrom(target, ssrfAgent, limits.signal, meter, importer))
    );
    return 'refusal' in imported ? uploadBudgetRefusalResponse(imported.refusal, instanceUri, importer.plan) : imported.result;
  } catch (err: unknown) {
    if (err instanceof JobTimeoutError) return importTimedOut(err.timeoutMs);
    return deadlineErrorResponse(err, instanceUri) ?? serverFault<UrlImportErrorCode>('fetch-url', err, 'Failed to fetch remote URL', 'fetch_failed');
  } finally {
    ssrfAgent.close().catch(() => {});
    slot.release();
  }
});
