import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders, isScopeAllowed, type ApiAuthResult } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import {
  getWebhookSecretStore,
  MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER,
  requireWebhookTargetId,
  WebhookEndpointLimitError,
  WebhookTargetRequiredError,
} from '@/lib/api-keys/webhook-secret-store';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import {
  validateOrProblem,
  WebhookSecretRotateRequestSchema,
} from '@/lib/api/contracts';

export const dynamic = 'force-dynamic';

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const ADMIN_SCOPE = '*';

export interface WebhookSecretRotateRequest {
  endpointId?: string;
  apiKeyId?: string;
  graceSeconds?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/webhooks/secrets/rotate';

  // 1. Authenticate caller (requires 'convert:write' scope or a session). Which secrets it may rotate is decided in step 3b.
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

  // 2. Parse request payload
  let rawBody: unknown;
  try {
    const text = await req.text();
    rawBody = text.trim().length > 0 ? JSON.parse(text) : {};
  } catch {
    return createProblemDetailsResponse(
      400,
      'Malformed JSON payload in request body.',
      instanceUri
    );
  }

  // 3. Schema validation against WebhookSecretRotateRequestSchema
  const validation = validateOrProblem<WebhookSecretRotateRequest>(
    WebhookSecretRotateRequestSchema,
    rawBody,
    instanceUri
  );

  if (!validation.ok) {
    return validation.response;
  }

  const { endpointId, graceSeconds = 86400 } = validation.data;
  const apiKeyId = validation.data.apiKeyId?.trim() ? validation.data.apiKeyId : undefined;
  // Every secret belongs to one endpoint or API key; there is no shared default slot.
  let targetId: string;
  try {
    targetId = requireWebhookTargetId(endpointId, apiKeyId);
  } catch (error) {
    if (!(error instanceof WebhookTargetRequiredError)) throw error;
    return createProblemDetailsResponse(error.status, error.message, instanceUri);
  }

  // 3b. A signing secret is returned in plaintext, so who may rotate which one is decided here: a session (the account's owner)
  // or an admin key may rotate any secret of the account; any other key only its own.
  const denied = authorizeRotation(auth, endpointId, apiKeyId, instanceUri);
  if (denied) return denied;
  const keyTarget = apiKeyId !== undefined && targetId === apiKeyId;
  // A named key must be an active key of this account; an unknown id and another account's id answer alike.
  const ownKey = apiKeyId === undefined ? undefined : (await redisKeyStore.listApiKeys(auth.user.id)).find((key) => key.id === apiKeyId && key.status === 'active');
  if (apiKeyId !== undefined && !ownKey) {
    return createProblemDetailsResponse(HTTP_NOT_FOUND, 'API key not found.', instanceUri);
  }

  // 4. Rotate secret in enterprise WebhookSecretStore
  const store = getWebhookSecretStore();
  // A key that has no record yet signs with the secret it was created with: that secret becomes the record the rotation then
  // moves to the previous one, so the first rotation has a grace period too. An endpoint record never takes the key's secret.
  if (keyTarget && ownKey?.webhookSecret) await store.seedPrimarySecretIfAbsent(auth.user.id, targetId, ownKey.webhookSecret);
  let rotationResult;
  try {
    rotationResult = await store.rotateSecret(auth.user.id, targetId, graceSeconds, keyTarget ? {} : { endpointLimit: MAX_ENDPOINT_SECRET_RECORDS_PER_OWNER });
  } catch (error) {
    if (!(error instanceof WebhookEndpointLimitError)) throw error;
    return createProblemDetailsResponse(error.status, error.message, instanceUri);
  }

  // 5. Keep redisKeyStore in sync when the key itself was rotated (an endpoint's secret never becomes the key's)
  if (keyTarget && apiKeyId !== undefined) {
    try {
      await redisKeyStore.updateApiKey(auth.user.id, apiKeyId, {
        webhookSecret: rotationResult.newSecret,
      });
    } catch {
      // In-memory or key not present in redisKeyStore; secret store remains SSOT
    }
  }

  // 6. Return standard 200 response with newly generated secret
  return NextResponse.json(
    {
      success: true,
      secret: rotationResult.newSecret,
      expiresAt: rotationResult.expiresAt,
      graceSeconds: rotationResult.graceSeconds,
      previousExpiresAt: rotationResult.previousExpiresAt,
    },
    { status: 200 }
  );
}

/**
 * The refusal of a caller that may not rotate the secret it names, or null. A session or a key of the admin scope (`*`) may
 * rotate any secret of its account, endpoints included; any other key only the secret of its own id, so a low-privilege key
 * cannot read the new signing secret of a stronger one.
 */
function authorizeRotation(auth: ApiAuthResult, endpointId: string | undefined, apiKeyId: string | undefined, instanceUri: string): NextResponse | null {
  if (auth.authMethod !== 'api_key' || isScopeAllowed(auth.apiKey?.scopes, ADMIN_SCOPE)) return null;
  const ownSecretOnly = endpointId === undefined && apiKeyId !== undefined && apiKeyId === auth.apiKey?.id;
  if (ownSecretOnly) return null;
  return createProblemDetailsResponse(
    HTTP_FORBIDDEN,
    "Forbidden: this API key may rotate only its own webhook secret (apiKeyId equal to its own id); other secrets need the admin scope '*' or a signed-in session.",
    instanceUri
  );
}
