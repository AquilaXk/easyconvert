import type { NextResponse } from 'next/server';
import { authStoreUnavailableRefusal } from '../api/problem-details';
import { getSessionFromRequest } from './session';
import { AuthStoreUnavailableError } from './store-unavailable';
import type { User } from './types';

/**
 * The signed-in person of a request (null for none), or the 503 to answer when the store that checks sessions cannot answer: a
 * session that cannot be checked is neither signed in nor signed out, so the browser retries and is not sent to the login page.
 */
export async function readSessionOrRefusal(req: Request): Promise<{ user: User | null } | { refused: NextResponse }> {
  try {
    return { user: await getSessionFromRequest(req) };
  } catch (error) {
    if (error instanceof AuthStoreUnavailableError) return { refused: authStoreUnavailableRefusal(error) };
    throw error;
  }
}
