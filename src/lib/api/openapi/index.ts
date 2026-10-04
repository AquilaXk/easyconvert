import { components } from './components';
import { webhookEvents } from './events';
import { conversionPaths } from './paths/conversion';
import { internalPaths } from './paths/internal';
import { keyPaths } from './paths/keys';
import { storagePaths } from './paths/storage';
import { uploadPaths } from './paths/uploads';
import { webhookPaths } from './paths/webhooks';

/** Builds the OpenAPI 3.1 document, the single source for API reference docs and SDKs. */
export function buildOpenApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'EasyConvert Enterprise REST API',
      version: '1.0.0',
      description:
        'Enterprise data, media, document, CAD, and RAW conversion platform with asynchronous job queues, zero-heap streaming, dead-letter webhook queues, and granular RBAC scopes. Operations marked `x-internal` serve the web application and are not part of the public contract.',
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
      ...webhookPaths,
      ...internalPaths,
    },
    webhooks: webhookEvents,
    components,
  };
}
