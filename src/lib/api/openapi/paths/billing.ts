import { BILLING_REFUSAL_CODES } from '@/lib/refusal-codes';
import { PAID_PLANS } from '@/lib/billing/types';
import { PUBLIC_ACCESS, SESSION_ONLY, createCodedErrorResponse, createJsonResponse, jsonBody } from '../shared';

const INTERNAL = { 'x-internal': true };

const UNAVAILABLE = createCodedErrorResponse('Paid plans are not available on this server: billing is not fully configured (`billing_unavailable`).', ['billing_unavailable']);

/** Paid plans: the status the web application reads, the checkout and portal of a signed-in account, and the payment provider's webhook. */
export const billingPaths = {
  '/api/billing/status': {
    get: {
      ...INTERNAL,
      summary: 'Get Billing Status',
      description:
        'Tells whether paid plans are on sale. While billing is not fully configured the answer is `enabled: false` and nothing else. When it is, the answer carries what the browser needs to open a checkout (the environment, the public client token and the price id of each paid plan) and, for a signed-in account, its subscription.',
      operationId: 'getBillingStatus',
      security: PUBLIC_ACCESS,
      responses: {
        '200': createJsonResponse('Whether paid plans are on sale.', {
          success: { type: 'boolean' },
          enabled: { type: 'boolean' },
          environment: { type: 'string', enum: ['sandbox', 'production'] },
          clientToken: { type: 'string' },
          plans: {
            type: 'array',
            items: { type: 'object', properties: { plan: { type: 'string', enum: [...PAID_PLANS] }, priceId: { type: 'string' } } },
          },
          subscription: {
            type: 'object',
            nullable: true,
            properties: {
              plan: { type: 'string', enum: [...PAID_PLANS] },
              status: { type: 'string', enum: ['active', 'trialing', 'past_due', 'paused', 'canceled'] },
              currentPeriodEnd: { type: 'number', description: 'Unix timestamp in milliseconds.' },
              cancelAt: { type: 'number', description: 'Unix timestamp in milliseconds when a scheduled cancellation takes effect.' },
              active: { type: 'boolean', description: 'Whether the subscription gives the account its plan now.' },
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
      description: 'Returns what Paddle.js needs to open the checkout of a paid plan for the signed-in account: the price, the customer\'s address and the account id, signed by this server.',
      operationId: 'startCheckout',
      security: SESSION_ONLY,
      requestBody: jsonBody({ plan: { type: 'string', enum: [...PAID_PLANS] } }, ['plan']),
      responses: {
        '200': createJsonResponse('The checkout to open.', { success: { type: 'boolean' }, checkout: { type: 'object' } }),
        '400': createCodedErrorResponse('The plan is not one that is sold (`invalid_plan`).', ['invalid_plan']),
        '401': { description: 'No signed-in session.' },
        '409': createCodedErrorResponse('The account already has a paid plan (`already_subscribed`); change or cancel it in the billing portal.', ['already_subscribed']),
        '503': UNAVAILABLE,
      },
    },
  },
  '/api/billing/portal': {
    post: {
      ...INTERNAL,
      summary: 'Open the Billing Portal',
      description: 'Returns a link to the payment provider\'s portal, where the signed-in subscriber changes the payment method and cancels the plan, and a link that goes straight to the cancellation.',
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
        'The notification destination of Paddle. The body is verified against the `Paddle-Signature` header (timestamp and HMAC-SHA256 of the exact body, with a window of 5 seconds) and applied once by its event id. Nothing but Paddle should call it.',
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
