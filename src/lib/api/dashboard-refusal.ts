import type { NextRequest, NextResponse } from 'next/server';
import { authErrorHeaders, extractApiKeySecret, validateApiAccess } from '@/lib/api-keys/guard';
import type { ApiKeyScope } from '@/lib/api-keys/types';
import { getSessionFromRequest } from '@/lib/auth/session';
import type { User } from '@/lib/auth/types';
import type { DashboardRefusalCode } from '@/lib/refusal-codes';
import { codedRefusal } from './problem-details';

const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** A refusal of a dashboard route, with a code of its closed list where the status cannot say the cause. */
export const dashboardRefusal = codedRefusal<DashboardRefusalCode>;

export interface DashboardAccess {
  /** What the caller does, as the English refusals of the route name it ("revoke API keys"). */
  action: string;
  /** Whether a key needs the `*` scope, as for changing keys and failed webhooks; a signed-in person always may. */
  adminKey?: boolean;
  /** The scope a key needs to read with this route. */
  scope?: ApiKeyScope;
}

/**
 * The person a dashboard route acts for: the owner of the key the request carries, else the signed-in person, or the
 * refusal. A key is an explicit credential, so it decides over a session cookie sent with it. A refusal of the access check
 * carries its status and `Retry-After` and no code, since the status names its cause; a key without a scope the route
 * needs answers `admin_scope_required`.
 */
export async function resolveDashboardCaller(
  req: NextRequest,
  { action, adminKey = false, scope }: DashboardAccess
): Promise<{ user: User } | { refused: NextResponse }> {
  const sessionUser = extractApiKeySecret(req) ? null : await getSessionFromRequest(req);
  if (sessionUser) return { user: sessionUser };

  const auth = await validateApiAccess(req, 0, scope);
  if (!auth.authorized || !auth.user) {
    const error = auth.error ?? `Unauthorized: sign in or use a valid API key to ${action}.`;
    return { refused: codedRefusal(auth.status ?? HTTP_UNAUTHORIZED, undefined, error, {}, authErrorHeaders(auth)) };
  }
  if (adminKey && auth.apiKey && !auth.apiKey.scopes?.includes('*')) {
    return { refused: dashboardRefusal(HTTP_FORBIDDEN, 'admin_scope_required', `Forbidden: API key lacks admin wildcard (*) scope to ${action}.`) };
  }
  return { user: auth.user };
}
