import type { UserTier } from '../auth/types';
import type { SubscriptionRecord, SubscriptionStatus } from './types';

/** The tier a subscription gives, and when it stops giving it (undefined: until the provider says otherwise). */
export interface Entitlement {
  tier: UserTier;
  until?: number;
}

const FREE: Entitlement = { tier: 'free' };

/** Whether a subscription in this status can hold a plan. */
export function isEntitlingStatus(status: SubscriptionStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

/**
 * What a subscription gives at `now`. An active or trialing one gives its plan, until the end of a scheduled cancellation if
 * there is one. A past-due one (a renewal payment failed) keeps the plan until the period that was paid for ends. A canceled
 * or paused one gives nothing: the provider cancels at the end of the period, and a pause stops the service.
 */
export function entitlementOf(subscription: SubscriptionRecord, now: number): Entitlement {
  let until: number | undefined;
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      until = subscription.cancelAt;
      break;
    case 'past_due':
      if (subscription.currentPeriodEnd === undefined) return FREE;
      until = subscription.currentPeriodEnd;
      break;
    case 'paused':
    case 'canceled':
      return FREE;
  }
  if (until !== undefined && until <= now) return FREE;
  return until === undefined ? { tier: subscription.plan } : { tier: subscription.plan, until };
}
