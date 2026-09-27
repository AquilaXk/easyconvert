import { NextRequest, NextResponse } from 'next/server';
import { fetch as undiciFetch } from 'undici';
import {
  MAX_STREAM_BYTES,
  MAX_REDIRECTS,
  validateUrlForSsrf,
  createSsrfSafeAgent,
} from '@/lib/security/ssrf';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const ssrfAgent = createSsrfSafeAgent();
  try {
    const body = await req.json();
    const { url } = body;

    if (!url || typeof url !== 'string') {
      return NextResponse.json({ success: false, error: 'URL is required.' }, { status: 400 });
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid URL format provided.' },
        { status: 400 }
      );
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return NextResponse.json(
        { success: false, error: 'Only HTTP and HTTPS URLs are permitted.' },
        { status: 400 }
      );
    }

    let currentUrl = parsedUrl;
    let res: Response | null = null;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const isValid = await validateUrlForSsrf(currentUrl);
      if (!isValid) {
        return NextResponse.json(
          { success: false, error: 'Requests to internal/private addresses are blocked.' },
          { status: 403 }
        );
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
          return NextResponse.json(
            { success: false, error: 'Requests to internal/private addresses are blocked.' },
            { status: 403 }
          );
        }
        throw fetchErr;
      } finally {
        clearTimeout(timeout);
      }

      // Handle redirect manually with recursive DNS/IP validation
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) {
          return NextResponse.json(
            { success: false, error: `Redirect status ${res.status} missing Location header` },
            { status: 502 }
          );
        }
        if (redirectCount === MAX_REDIRECTS) {
          return NextResponse.json(
            { success: false, error: 'Too many redirects encountered.' },
            { status: 502 }
          );
        }
        try {
          const nextUrl = new URL(location, currentUrl);
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            return NextResponse.json(
              { success: false, error: 'Only HTTP and HTTPS URLs are permitted.' },
              { status: 400 }
            );
          }
          currentUrl = nextUrl;
          continue;
        } catch {
          return NextResponse.json(
            { success: false, error: 'Invalid redirect location URL.' },
            { status: 502 }
          );
        }
      }

      break;
    }

    if (!res) {
      return NextResponse.json({ success: false, error: 'Failed to fetch remote URL' }, { status: 502 });
    }

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Remote server returned HTTP ${res.status}: ${res.statusText}` },
        { status: res.status >= 400 && res.status < 500 ? 400 : 502 }
      );
    }

    // Check Content-Length upfront if provided
    const contentLengthHeader = res.headers.get('content-length');
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength) && contentLength > MAX_STREAM_BYTES) {
        return NextResponse.json(
          { success: false, error: 'File size exceeds 100MB limit.' },
          { status: 413 }
        );
      }
    }

    if (!res.body) {
      return NextResponse.json({ success: false, error: 'Empty response body from remote server' }, { status: 502 });
    }

    // Stream chunks with strict 100MB limit counter
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.length;
          if (totalBytes > MAX_STREAM_BYTES) {
            await reader.cancel();
            return NextResponse.json(
              { success: false, error: 'File size exceeds 100MB limit.' },
              { status: 413 }
            );
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

    // Ensure extension
    if (!filename.includes('.')) {
      if (contentType.includes('image/png')) filename += '.png';
      else if (contentType.includes('image/jpeg')) filename += '.jpg';
      else if (contentType.includes('image/webp')) filename += '.webp';
      else if (contentType.includes('application/pdf')) filename += '.pdf';
      else if (contentType.includes('text/csv')) filename += '.csv';
      else if (contentType.includes('application/json')) filename += '.json';
      else filename += '.bin';
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
    const msg = err instanceof Error ? err.message : 'Failed to fetch remote URL';
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  } finally {
    ssrfAgent.close().catch(() => {});
  }
}
