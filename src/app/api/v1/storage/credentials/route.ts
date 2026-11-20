import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import {
  credentialsVault,
  CredentialsVaultPersistenceError,
  CustomerStorageCredentials,
  StorageProviderType,
  StorageAdapterError,
  validateStorageCredentials,
} from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { MAX_STORAGE_CREDENTIAL_JSON_BYTES, MAX_STORAGE_CREDENTIAL_NAME_LENGTH } from '@/lib/api/field-limits';
import { withRateLimitHeaders } from '@/lib/api/rate-limit';
import { refuseUnavailableStorageProvider } from '@/lib/api/byos-provider-guard';
import { PROBLEM_TYPE_BASE } from '@/lib/refusal-codes';

export const dynamic = 'force-dynamic';

const BYOS_INVALID_ENDPOINT_TYPE = `${PROBLEM_TYPE_BASE}byos-invalid-endpoint`;

/**
 * The 500 for an error this route did not classify, in the problem+json shape of the other `/api/v1` routes. The text of the error can name a
 * host or a path, so the answer is a fixed sentence and the error goes to the server log (as `serverFault` does for the routes of the web application).
 */
function unclassifiedFailure(error: unknown, sentence: string, instanceUri: string): NextResponse {
  console.error('[v1/storage/credentials]', error);
  return createProblemDetailsResponse(500, sentence, instanceUri, 'Internal Server Error');
}

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/storage/credentials';

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
  if (!auth.authorized || !auth.user) {
    return withRateLimitHeaders(
      createProblemDetailsResponse(
        auth.status ?? 401,
        auth.error ?? 'Unauthorized',
        instanceUri,
        undefined,
        auth.problemType,
        authErrorHeaders(auth)
      ),
      auth.rateLimit
    );
  }

  return withRateLimitHeaders(await postCredentialsAuthorized(req, instanceUri, auth.user.id), auth.rateLimit);
}

async function postCredentialsAuthorized(req: NextRequest, instanceUri: string, userId: string): Promise<NextResponse> {

  let body: {
    providerType: StorageProviderType;
    credentials: CustomerStorageCredentials;
    name?: string;
    ttlSeconds?: number;
  };

  try {
    body = await req.json();
  } catch {
    return createProblemDetailsResponse(400, 'Invalid JSON request body.', instanceUri);
  }

  const { providerType, credentials, name, ttlSeconds } = body;
  if (!providerType || !credentials) {
    return createProblemDetailsResponse(
      400,
      'Missing "providerType" or "credentials" in payload.',
      instanceUri
    );
  }

  if (
    ttlSeconds !== undefined &&
    (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 90 * 86400)
  ) {
    return createProblemDetailsResponse(
      400,
      'Invalid "ttlSeconds": must be an integer between 60 and 7776000 (90 days).',
      instanceUri
    );
  }

  if (name !== undefined && (typeof name !== 'string' || name.length > MAX_STORAGE_CREDENTIAL_NAME_LENGTH)) {
    return createProblemDetailsResponse(
      400,
      `Invalid "name": must be a string of at most ${MAX_STORAGE_CREDENTIAL_NAME_LENGTH} characters.`,
      instanceUri
    );
  }

  if (Buffer.byteLength(JSON.stringify(credentials)) > MAX_STORAGE_CREDENTIAL_JSON_BYTES) {
    return createProblemDetailsResponse(
      400,
      `Invalid "credentials": at most ${MAX_STORAGE_CREDENTIAL_JSON_BYTES} bytes as JSON.`,
      instanceUri
    );
  }

  const unavailable = refuseUnavailableStorageProvider(providerType, instanceUri);
  if (unavailable) {
    return unavailable;
  }

  if (credentials.type !== providerType) {
    return createProblemDetailsResponse(
      400,
      `Mismatch between providerType "${providerType}" and credentials.type "${credentials.type}".`,
      instanceUri
    );
  }

  try {
    await validateStorageCredentials(credentials);
  } catch (err: unknown) {
    if (err instanceof StorageAdapterError) {
      return createProblemDetailsResponse(
        400,
        err.message,
        instanceUri,
        'Invalid Storage Endpoint',
        BYOS_INVALID_ENDPOINT_TYPE
      );
    }
    throw err;
  }

  try {
    const credentialRef = await credentialsVault.store(userId, credentials, {
      name,
      ttlSeconds,
    });

    return NextResponse.json(
      {
        success: true,
        credentialRef,
        providerType,
        name,
        expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    if (err instanceof CredentialsVaultPersistenceError) {
      return createProblemDetailsResponse(503, err.message, instanceUri);
    }
    return unclassifiedFailure(err, 'Failed to register credentials.', instanceUri);
  }
}

export async function GET(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/storage/credentials';

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
  if (!auth.authorized || !auth.user) {
    return withRateLimitHeaders(
      createProblemDetailsResponse(
        auth.status ?? 401,
        auth.error ?? 'Unauthorized',
        instanceUri,
        undefined,
        auth.problemType,
        authErrorHeaders(auth)
      ),
      auth.rateLimit
    );
  }

  try {
    const list = await credentialsVault.list(auth.user.id);
    return withRateLimitHeaders(
      NextResponse.json({
        success: true,
        credentials: list,
      }),
      auth.rateLimit
    );
  } catch (err: unknown) {
    if (err instanceof CredentialsVaultPersistenceError) {
      return withRateLimitHeaders(createProblemDetailsResponse(503, err.message, instanceUri), auth.rateLimit);
    }
    return withRateLimitHeaders(unclassifiedFailure(err, 'Failed to retrieve credentials.', instanceUri), auth.rateLimit);
  }
}
