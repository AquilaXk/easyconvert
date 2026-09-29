import { NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from './guard';

/**
 * Restricts a resource to the user that owns it.
 * Resources without an owner (anonymous uploads) keep capability-URL access.
 * For an owned resource, any caller other than the owner gets the route's regular not-found
 * response so resource identifiers cannot be probed; the owner still sees the guard's own
 * rejection (missing scope, burst limit) so the request can be fixed.
 * Returns the response to send when access is denied, or null when the caller may proceed.
 */
export async function denyUnlessOwner(
  req: Request,
  ownerUserId: string | undefined,
  requiredScope: string,
  notFound: () => NextResponse
): Promise<NextResponse | null> {
  if (!ownerUserId) {
    return null;
  }

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope });
  if (auth.user?.id !== ownerUserId) {
    return notFound();
  }
  if (!auth.authorized) {
    return NextResponse.json(
      { success: false, error: auth.error ?? 'Unauthorized' },
      { status: auth.status ?? 401, headers: authErrorHeaders(auth) }
    );
  }
  return null;
}
