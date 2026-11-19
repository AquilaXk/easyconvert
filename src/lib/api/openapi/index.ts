import { LEGAL_DOCUMENTS } from '../../legal/documents';
import { getAppOrigin } from '../../auth/oauth';
import { components } from './components';
import { webhookEvents } from './events';
import { PLAN_FILE_LIMITS_PLACEHOLDER, planFileLimitsText } from './shared';
import { billingPaths } from './paths/billing';
import { conversionPaths } from './paths/conversion';
import { internalPaths } from './paths/internal';
import { keyPaths } from './paths/keys';
import { storagePaths } from './paths/storage';
import { uploadPaths } from './paths/uploads';
import { webhookPaths } from './paths/webhooks';

function mergePaths(...maps: Array<Record<string, Record<string, unknown>>>): Record<string, Record<string, unknown>> {
  const merged: Record<string, Record<string, unknown>> = {};
  for (const map of maps) {
    for (const [pathname, operations] of Object.entries(map)) {
      merged[pathname] = { ...(merged[pathname] ?? {}), ...operations };
    }
  }
  return merged;
}

/**
 * Builds the OpenAPI 3.1 document, the single source for API reference docs and SDKs. `info.termsOfService` must be an absolute
 * URL (OpenAPI 3.1, Info Object), so it is resolved against the configured public origin, never the request's Host. The plan limits in
 * the descriptions are written when the document is built, so they follow the server's configuration (`planFileLimitsText`).
 */
export function buildOpenApiDocument() {
  const document = {
    openapi: '3.1.0',
    info: {
      title: 'EasyConvert API',
      version: '1.0.0',
      description:
        'Converts files over HTTP: one request for a small file, a job for a large one. Public `/api/v1/*` routes support wildcard CORS for Bearer/API-key requests and return IETF `RateLimit-*` quota headers. Operations marked `x-internal` serve the web application and are excluded from the public `/api/v1/openapi.json` document.',
      termsOfService: new URL(LEGAL_DOCUMENTS.terms.path, getAppOrigin()).href,
      contact: {
        name: 'EasyConvert Engineering',
        url: 'https://github.com/AquilaXk/easyconvert',
      },
      license: {
        name: 'Apache-2.0',
        url: 'https://www.apache.org/licenses/LICENSE-2.0',
      },
    },
    servers: [
      {
        url: '/',
        description: 'Current Environment Origin',
      },
    ],
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    paths: mergePaths(
      conversionPaths,
      uploadPaths,
      storagePaths,
      keyPaths,
      billingPaths,
      webhookPaths,
      internalPaths,
    ),
    webhooks: webhookEvents,
    components,
  };
  return JSON.parse(JSON.stringify(document).replaceAll(PLAN_FILE_LIMITS_PLACEHOLDER, planFileLimitsText())) as typeof document;
}

const OPENAPI_HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

/**
 * Returns the public-only OpenAPI 3.1 document served at `/api/v1/openapi.json` and `/api/v1/openapi`,
 * stripping operations marked `x-internal: true` and dropping any path item left without public operations.
 */
export function buildPublicOpenApiDocument() {
  const full = buildOpenApiDocument();
  const publicPaths: Record<string, Record<string, unknown>> = {};

  for (const [pathname, pathItem] of Object.entries(full.paths)) {
    const filtered: Record<string, unknown> = {};
    let publicOpCount = 0;

    for (const [key, value] of Object.entries(pathItem)) {
      if (OPENAPI_HTTP_METHODS.has(key.toLowerCase())) {
        const isInternal = typeof value === 'object' && value !== null && (value as { 'x-internal'?: unknown })['x-internal'] === true;
        if (!isInternal) {
          filtered[key] = value;
          publicOpCount++;
        }
      } else {
        filtered[key] = value;
      }
    }

    if (publicOpCount > 0) {
      publicPaths[pathname] = filtered;
    }
  }

  return {
    ...full,
    paths: publicPaths,
  };
}
