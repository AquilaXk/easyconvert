import type { VariableSpec } from './schema';

/** The variables that turn on paid plans; `src/lib/config/index.ts` refuses a configuration that sets only some of them. */

const WEB = ['web'] as const;
const PADDLE_ENVIRONMENTS = ['sandbox', 'production'] as const;

export const BILLING_ENTRIES = [
  {
    name: 'PADDLE_API_KEY',
    area: 'billing',
    description:
      'Server-side API key of the Paddle account that sells the paid plans (opens customer portal sessions). Paid plans are on sale only when this and the five other PADDLE_ variables are all set; set only some of them and start-up fails. Until then the pricing page marks the paid plans "coming soon" and every billing route answers 503 billing_unavailable.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: WEB,
  },
  {
    name: 'PADDLE_WEBHOOK_SECRET',
    area: 'billing',
    description:
      'Secret key of the Paddle notification destination that points at /api/billing/webhook. It verifies the Paddle-Signature header of every event, and signs the user id that a checkout carries as custom data.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: WEB,
  },
  {
    name: 'PADDLE_CLIENT_TOKEN',
    area: 'billing',
    description: 'Client-side token that Paddle.js opens the checkout with. It is meant to be public: the billing status route hands it to the browser.',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'PADDLE_ENVIRONMENT',
    area: 'billing',
    description: 'The Paddle environment the API key, the client token and the price ids belong to: `sandbox` for tests with test cards, `production` for real payments.',
    kind: { type: 'enum', values: PADDLE_ENVIRONMENTS, caseInsensitive: true },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'PADDLE_PRICE_ID_PRO',
    area: 'billing',
    description: 'Id of the Paddle price (`pri_...`) of the Pro plan.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'PADDLE_PRICE_ID_ENTERPRISE',
    area: 'billing',
    description: 'Id of the Paddle price (`pri_...`) of the Enterprise plan.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
] as const satisfies readonly VariableSpec[];
