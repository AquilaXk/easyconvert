import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function isPrivateIpOrHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '0.0.0.0' ||
    lower === '::1' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }

  // Check IPv4 private ranges
  const ipv4Parts = hostname.split('.').map(Number);
  if (ipv4Parts.length === 4 && !ipv4Parts.some(isNaN)) {
    const [a, b] = ipv4Parts;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12 (172.16 - 172.31)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
  }

  return false;
}

export async function POST(req: NextRequest) {
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

    if (isPrivateIpOrHost(parsedUrl.hostname)) {
      return NextResponse.json(
        { success: false, error: 'Requests to internal/private addresses are blocked.' },
        { status: 403 }
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'EasyConvert-Universal-Ingestion/1.0',
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return NextResponse.json(
        { success: false, error: `Remote server returned HTTP ${res.status}: ${res.statusText}` },
        { status: res.status >= 400 && res.status < 500 ? 400 : 502 }
      );
    }

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
      const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
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

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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
  }
}
