import { NextRequest, NextResponse } from 'next/server';
import { validateApiAccess, authErrorHeaders } from '@/lib/api-keys/guard';
import { redisKeyStore } from '@/lib/api-keys/redis-key-store';
import {
  getWebhookSecretStore,
  requireWebhookTargetId,
  WebhookTargetRequiredError,
} from '@/lib/api-keys/webhook-secret-store';
import { createProblemDetailsResponse } from '@/lib/api/problem-details';
import {
  validateOrProblem,
  WebhookSecretRotateRequestSchema,
} from '@/lib/api/contracts';

export const dynamic = 'force-dynamic';

export interface WebhookSecretRotateRequest {
  endpointId?: string;
  apiKeyId?: string;
  graceSeconds?: number;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const instanceUri = req.nextUrl?.pathname || '/api/v1/webhooks/secrets/rotate';

  // 1. Authenticate caller (requires 'convert:write' scope or admin/session)
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

  const { endpointId, apiKeyId, graceSeconds = 86400 } = validation.data;
  // Every secret belongs to one endpoint or API key; there is no shared default slot.
  let targetId: string;
  try {
    targetId = requireWebhookTargetId(endpointId, apiKeyId);
  } catch (error) {
    if (!(error instanceof WebhookTargetRequiredError)) throw error;
    return createProblemDetailsResponse(error.status, error.message, instanceUri);
  }

  // 4. Rotate secret in enterprise WebhookSecretStore
  const store = getWebhookSecretStore();
  const rotationResult = await store.rotateSecret(auth.user.id, targetId, graceSeconds);

  // 5. Keep redisKeyStore in sync if apiKeyId was provided
  if (apiKeyId) {
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
