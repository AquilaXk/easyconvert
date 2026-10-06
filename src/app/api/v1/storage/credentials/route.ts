import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import {
  credentialsVault,
  CustomerStorageCredentials,
  StorageProviderType,
  StorageAdapterError,
  validateStorageCredentials,
} from '@/lib/storage';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import { refuseUnavailableStorageProvider } from '@/lib/api/byos-provider-guard';

export const dynamic = 'force-dynamic';

const BYOS_INVALID_ENDPOINT_TYPE = 'https://api.easyconvert.io/problems/byos-invalid-endpoint';

export async function POST(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/storage/credentials';

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:write' });
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
    const credentialRef = await credentialsVault.store(auth.user.id, credentials, {
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
    const message = err instanceof Error ? err.message : 'Failed to register credentials';
    return createProblemDetailsResponse(500, message, instanceUri);
  }
}

export async function GET(req: NextRequest) {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/storage/credentials';

  const auth = await validateApiAccess(req, { requiredUnits: 0, requiredScope: 'convert:read' });
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

  try {
    const list = await credentialsVault.list(auth.user.id);
    return NextResponse.json({
      success: true,
      credentials: list,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to retrieve credentials';
    return createProblemDetailsResponse(500, message, instanceUri);
  }
}
