import type { NextResponse } from 'next/server';
import { AuthStoreUnavailableError } from '@/lib/auth/store-unavailable';
import type { BillingRefusalCode } from '@/lib/refusal-codes';
import { authStoreUnavailableRefusal, codedRefusal } from './problem-details';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;

const refusal = codedRefusal<BillingRefusalCode>;

/** What every paid route answers while billing is not fully configured: nothing can be bought or managed. */
export const billingUnavailable = (): NextResponse =>
  refusal(HTTP_SERVICE_UNAVAILABLE, 'billing_unavailable', 'Paid plans are not available on this server.');

export const invalidPlan = (): NextResponse => refusal(HTTP_BAD_REQUEST, 'invalid_plan', 'Choose one of the plans that are on sale: "pro" or "enterprise".');

export const alreadySubscribed = (): NextResponse =>
  refusal(HTTP_CONFLICT, 'already_subscribed', 'This account already has a paid plan. Change or cancel it from the billing portal.');

export const noSubscription = (): NextResponse => refusal(HTTP_NOT_FOUND, 'no_subscription', 'This account has no subscription.');

export const providerFailed = (): NextResponse =>
  refusal(HTTP_BAD_GATEWAY, 'billing_provider_failed', 'The payment provider could not be reached. Try again shortly.');

export const invalidSignature = (): NextResponse => refusal(HTTP_BAD_REQUEST, 'invalid_signature', 'The webhook signature is missing or not valid.');

/** Runs a route step that reads or writes subscriptions; a store that cannot answer is the 503 every account route gives. */
export async function guardingStore(step: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof AuthStoreUnavailableError) return authStoreUnavailableRefusal(error);
    throw error;
  }
}
