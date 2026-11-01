import { NextRequest, NextResponse } from 'next/server';
import { admittingNewFiles } from '@/lib/api/storage-full-response';
import { fetch as undiciFetch } from 'undici';
import {
  MAX_REDIRECTS,
  validateUrlForSsrf,
  createSsrfSafeAgent,
} from '@/lib/security/ssrf';
import { validateApiAccess, authErrorHeaders, commitQuota, rollbackQuota } from '@/lib/api-keys/guard';
import { codedRefusal, createProblemDetailsResponse, serverFault } from '@/lib/api/problem-details';
import { readJsonObject } from '@/lib/api/json-body';
import { formatBytes } from '@/lib/format-bytes';
import { URL_IMPORT_MAX_BYTES, maxFileBytes, planOfCaller, type PlanCaller } from '@/lib/plan-limits';
import type { UrlImportErrorCode } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const refusal = codedRefusal<UrlImportErrorCode>;

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

export const POST = admittingNewFiles(async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/fetch-url';

  // 1. Guard check: Authenticate API key/session or enforce anonymous IP rate limit & daily quota
  const auth = await validateApiAccess(req, {
    requiredUnits: 1,
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

  const reservationId = auth.reservationId;

  const failWithRollback = async (status: number, code: UrlImportErrorCode, error: string) => {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return refusal(status, code, error);
  };

  const refuseTooLarge = async () => {
    if (reservationId) await rollbackQuota(reservationId);
    return linkImportTooLarge(auth.user);
  };

  const ssrfAgent = createSsrfSafeAgent();
  try {
    const body = await readJsonObject(req);
    if (!body) {
      return await failWithRollback(400, 'invalid_json', 'Invalid JSON request payload.');
    }
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return await failWithRollback(400, 'url_required', 'URL is required.');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return await failWithRollback(400, 'invalid_url', 'Invalid URL format provided.');
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return await failWithRollback(400, 'unsupported_scheme', 'Only HTTP and HTTPS URLs are permitted.');
    }

    let currentUrl = parsedUrl;
    let res: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const isValid = await validateUrlForSsrf(currentUrl);
      if (!isValid) {
        return refusal(403, 'address_blocked', 'Requests to internal/private addresses are blocked.');
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);

      try {
        res = (await undiciFetch(currentUrl.toString(), {
          dispatcher: ssrfAgent,
          signal: controller.signal as any,
          redirect: 'manual',
          headers: {
            'User-Agent': 'EasyConvert-Universal-Ingestion/1.0',
          },
        })) as unknown as Response;
      } catch (fetchErr: unknown) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
        if (msg.includes('SSRF blocked') || msg.includes('restricted')) {
          return refusal(403, 'address_blocked', 'Requests to internal/private addresses are blocked.');
        }
        throw fetchErr;
      } finally {
        clearTimeout(timeout);
      }

      // Handle redirect manually with recursive DNS/IP validation
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return refusal(502, 'redirect_without_location', `Redirect status ${res.status} missing Location header`);
        }
        if (redirectCount === MAX_REDIRECTS) {
          return refusal(502, 'too_many_redirects', 'Too many redirects encountered.');
        }
        try {
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            return refusal(400, 'unsupported_scheme', 'Only HTTP and HTTPS URLs are permitted.');
          }
          currentUrl = nextUrl;
          continue;
        } catch {
          return refusal(502, 'invalid_redirect', 'Invalid redirect location URL.');
        }
      }

      break;
    }

    if (!res) {
      return refusal(502, 'fetch_failed', 'Failed to fetch remote URL');
    }

    if (!res.ok) {
      return refusal(
        res.status >= 400 && res.status < 500 ? 400 : 502,
        'remote_error',
        `Remote server returned HTTP ${res.status}: ${res.statusText}`,
        { remoteStatus: res.status }
      );
    }

    // Check Content-Length upfront if provided
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > URL_IMPORT_MAX_BYTES) {
        return await refuseTooLarge();
      }
    }

    if (!res.body) {
      return refusal(502, 'empty_body', 'Empty response body from remote server');
    }

    // Stream chunks with a strict byte counter
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > URL_IMPORT_MAX_BYTES) {
            await reader.cancel();
            return await refuseTooLarge();
          }
          chunks.push(value);
        }
      }
    } catch (streamErr: unknown) {
      await reader.cancel().catch(() => {});
      throw streamErr;
    }

    const buffer = Buffer.concat(chunks);

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
      const pathParts = currentUrl.pathname.split('/').filter(Boolean);
      filename = pathParts[pathParts.length - 1] || 'remote_file';
    }

    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    filename = withExtension(filename, contentType);

    if (reservationId) {
      await commitQuota(reservationId);
    }

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Filename': encodeURIComponent(filename),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': buffer.length.toString(),
      },
    });
  } catch (err: unknown) {
    if (reservationId) {
      await rollbackQuota(reservationId);
    }
    return serverFault<UrlImportErrorCode>('fetch-url', err, 'Failed to fetch remote URL', 'fetch_failed');
  } finally {
    ssrfAgent.close().catch(() => {});
  }
});
