import { LEGAL_DOCUMENTS } from '../../legal/documents';
import { getAppOrigin } from '../../auth/oauth';
import { components } from './components';
import { webhookEvents } from './events';
import { billingPaths } from './paths/billing';
import { conversionPaths } from './paths/conversion';
import { internalPaths } from './paths/internal';
import { keyPaths } from './paths/keys';
import { storagePaths } from './paths/storage';
import { uploadPaths } from './paths/uploads';
import { webhookPaths } from './paths/webhooks';

/**
 * Builds the OpenAPI 3.1 document, the single source for API reference docs and SDKs. `info.termsOfService` must be an absolute
 * URL (OpenAPI 3.1, Info Object), so it is resolved against the configured public origin, never the request's Host.
 */
export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'EasyConvert API',
      version: '1.0.0',
      description:
        'Converts files over HTTP: one request for a small file, a job for a large one. Operations marked `x-internal` serve the web application and are not part of the public contract.',
      termsOfService: new URL(LEGAL_DOCUMENTS.terms.path, getAppOrigin()).href,
      contact: {
        name: 'EasyConvert Engineering',
        url: 'https://github.com/AquilaXk/easyconvert',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: [
      {
        url: '/',
        description: 'Current Environment Origin',
      },
    ],
    security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
    paths: {
      ...conversionPaths,
      ...uploadPaths,
      ...storagePaths,
      ...keyPaths,
      ...billingPaths,
      ...webhookPaths,
      ...internalPaths,
    },
    webhooks: webhookEvents,
    components,
  };
}
