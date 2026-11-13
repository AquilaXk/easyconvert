import { BILLING_REFUSAL_CODES } from '@/lib/refusal-codes';
import { PACKAGE_SIZES, SUBSCRIPTION_SIZES } from '@/lib/billing/credits';
import { PUBLIC_ACCESS, SESSION_ONLY, createCodedErrorResponse, createJsonResponse, jsonBody } from '../shared';

const INTERNAL = { 'x-internal': true };

const UNAVAILABLE = createCodedErrorResponse('Paid plans are not available on this server: billing is not fully configured (`billing_unavailable`).', ['billing_unavailable']);

/** Packages and subscriptions: the status the web application reads, the checkout and portal of a signed-in account, and the payment provider's webhook. */
export const billingPaths = {
  '/api/billing/status': {
    get: {
      ...INTERNAL,
      summary: 'Get Billing Status',
      description:
        'Tells whether packages and subscriptions are on sale. While billing is not fully configured the answer is `enabled: false` and nothing else. When it is, the answer carries what the browser needs to open a checkout (the environment, the public client token and the price id of each package and subscription size) and, for a signed-in account, its subscription.',
      operationId: 'getBillingStatus',
      security: PUBLIC_ACCESS,
      responses: {
        '200': createJsonResponse('Whether packages and subscriptions are on sale.', {
          success: { type: 'boolean' },
          enabled: { type: 'boolean' },
          environment: { type: 'string', enum: ['sandbox', 'production'] },
          clientToken: { type: 'string' },
          packages: {
            type: 'array',
            description: 'The packages on sale: credits that are added once and never expire.',
            items: { type: 'object', properties: { credits: { type: 'integer', enum: [...PACKAGE_SIZES] }, priceId: { type: 'string' } } },
          },
          subscriptions: {
            type: 'array',
            description: 'The subscriptions on sale: credits that renew every billing period and do not roll over.',
            items: { type: 'object', properties: { credits: { type: 'integer', enum: [...SUBSCRIPTION_SIZES] }, priceId: { type: 'string' } } },
          },
          subscription: {
            type: 'object',
            nullable: true,
            properties: {
              credits: { type: 'integer', enum: [...SUBSCRIPTION_SIZES], description: 'Credits the subscription gives each billing period.' },
              status: { type: 'string', enum: ['active', 'trialing', 'past_due', 'paused', 'canceled'] },
              currentPeriodEnd: { type: 'number', description: 'Unix timestamp in milliseconds.' },
              cancelAt: { type: 'number', description: 'Unix timestamp in milliseconds when a scheduled cancellation takes effect.' },
              active: { type: 'boolean', description: 'Whether the subscription gives the account its credits and paid limits now.' },
            },
          },
        }),
      },
    },
  },
  '/api/billing/checkout': {
    post: {
      ...INTERNAL,
      summary: 'Start a Checkout',
      description:
        'Returns what Paddle.js needs to open the checkout of a package or a subscription for the signed-in account: the price, the customer\'s address and the account id, signed by this server. An account that already has a subscription and asks for a subscription of another size is moved to it at once (the full price of the new size is billed and the credits left of the old size do not carry over) and the answer has `changed: true` and no checkout.',
      operationId: 'startCheckout',
      security: SESSION_ONLY,
      requestBody: jsonBody(
        { kind: { type: 'string', enum: ['package', 'subscription'] }, credits: { type: 'integer', description: `The size: ${PACKAGE_SIZES.join(', ')} for a package, ${SUBSCRIPTION_SIZES.join(', ')} for a subscription.` } },
        ['kind', 'credits']
      ),
      responses: {
        '200': createJsonResponse('The checkout to open, or the subscription that was changed.', { success: { type: 'boolean' }, checkout: { type: 'object' }, changed: { type: 'boolean' } }),
        '400': createCodedErrorResponse('The package or subscription is not one that is sold (`invalid_product`).', ['invalid_product']),
        '401': { description: 'No signed-in session.' },
        '409': createCodedErrorResponse('The account already has a subscription of this size (`already_subscribed`).', ['already_subscribed']),
        '502': createCodedErrorResponse('The payment provider could not change the subscription (`billing_provider_failed`).', ['billing_provider_failed']),
        '503': UNAVAILABLE,
      },
    },
  },
  '/api/billing/portal': {
    post: {
      ...INTERNAL,
      summary: 'Open the Billing Portal',
      description: 'Returns a link to the payment provider\'s portal, where the signed-in subscriber changes the payment method and cancels the subscription, and a link that goes straight to the cancellation.',
      operationId: 'openBillingPortal',
      security: SESSION_ONLY,
      responses: {
        '200': createJsonResponse('The portal links.', { success: { type: 'boolean' }, url: { type: 'string', format: 'uri' }, cancelUrl: { type: 'string', format: 'uri' } }),
        '401': { description: 'No signed-in session.' },
        '404': createCodedErrorResponse('The account has no subscription (`no_subscription`).', ['no_subscription']),
        '502': createCodedErrorResponse('The payment provider could not be reached (`billing_provider_failed`).', ['billing_provider_failed']),
        '503': UNAVAILABLE,
      },
    },
  },
  '/api/billing/webhook': {
    post: {
      ...INTERNAL,
      summary: 'Receive Paddle Events',
      description:
        'The notification destination of Paddle. The body is verified against the `Paddle-Signature` header (timestamp and HMAC-SHA256 of the exact body, with a window of 5 seconds) and applied once by its event id: a subscription event sets the account\'s subscription, a completed payment for a package adds its credits once for each transaction id, and an approved refund or chargeback of a package takes back the credits of it that are unused. Nothing but Paddle should call it.',
      operationId: 'receiveBillingWebhook',
      security: PUBLIC_ACCESS,
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: {
        '200': createJsonResponse('The event was verified. `result` is `applied`, `duplicate`, `stale`, `other_subscription`, `unknown_user`, `unattributed` or `ignored`; none of them is worth a retry.', {
          success: { type: 'boolean' },
          result: { type: 'string' },
        }),
        '400': createCodedErrorResponse('The signature is missing, wrong or too old (`invalid_signature`).', ['invalid_signature']),
        '503': createCodedErrorResponse(
          'Billing is not configured (`billing_unavailable`), or the account store could not answer and Paddle should send the event again.',
          [...BILLING_REFUSAL_CODES]
        ),
      },
    },
  },
};
