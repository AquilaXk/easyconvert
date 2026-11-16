import { NextResponse } from 'next/server';
import { PUBLIC_DEFAULT_ORIGIN, siteMetadataBase } from '@/i18n/metadata';

const SECURITY_CONTACT = 'mailto:support@aquilaxk.site';
const EXPIRES_ISO = '2027-11-16T00:00:00.000Z';

/** RFC 9116 vulnerability disclosure policy (`/.well-known/security.txt`). */
export function GET(): NextResponse {
  const origin = siteMetadataBase()?.origin ?? PUBLIC_DEFAULT_ORIGIN;
  const body = [
    `Contact: ${SECURITY_CONTACT}`,
    `Expires: ${EXPIRES_ISO}`,
    'Preferred-Languages: en, ko',
    `Canonical: ${origin}/.well-known/security.txt`,
    `Policy: ${origin}/security`,
    '',
  ].join('\n');

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
