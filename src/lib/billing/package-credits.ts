import { redisUserStore } from '../auth/redis-user-store';
import { redisKeyStore, type RedisKeyStore } from '../api-keys/redis-key-store';
import type { PackagePurchase, PackageRefund } from './types';

/**
 * Package payments in the credit ledger (docs/policy-decisions.md, entry 285). The webhook, which reads one event, and the
 * reconciliation, which reads the provider's list, apply a payment through the same two functions, so a payment is credited once
 * whichever finds it first, and a refund takes back what is left of its credits once for each adjustment.
 */

export type PackageCreditResult = 'granted' | 'duplicate' | 'unknown_user';

/** Credits a completed package payment to its account: once for each transaction id, only for an account that exists. */
export async function creditPackagePurchase(purchase: PackagePurchase, userId: string, store: RedisKeyStore = redisKeyStore): Promise<PackageCreditResult> {
  if (!(await redisUserStore.findById(userId))) return 'unknown_user';
  return store.creditPackage(userId, { transactionId: purchase.transactionId, credits: purchase.credits, paid: purchase.paid, at: purchase.occurredAt });
}

export type PackageRefundResult = 'revoked' | 'duplicate' | 'unknown_transaction';

/**
 * Takes back the unused credits of a refunded or charged-back package payment (never below a zero balance) and logs what it took,
 * what conversions in flight hold (taken back when they end) and what was already spent. The payment is found by its transaction id in the index the credit wrote.
 */
export async function refundPackagePurchase(refund: PackageRefund, store: RedisKeyStore = redisKeyStore): Promise<PackageRefundResult> {
  const userId = await store.packageTransactionOwner(refund.transactionId);
  if (!userId) return 'unknown_transaction';
  const outcome = await store.revokePackage(userId, { transactionId: refund.transactionId, adjustmentId: refund.adjustmentId, amount: refund.amount, full: refund.full });
  if (outcome.status === 'unknown-transaction') return 'unknown_transaction';
  if (refund.action === 'chargeback') {
    await store.setBillingHold(userId, `${refund.action}:${refund.adjustmentId}`);
  }
  if (outcome.status === 'duplicate') return 'duplicate';
  console.warn(
    `[billing] ${refund.action} ${refund.adjustmentId} of package payment ${refund.transactionId}: took back ${outcome.revoked} credits of account ${userId}` +
      (outcome.deferred > 0 ? `, ${outcome.deferred} more are held by conversions in flight and are taken back when they end` : '') +
      (outcome.unrecovered > 0 ? `, ${outcome.unrecovered} more were owed and are already spent (carried as debt)` : '')
  );
  return 'revoked';
}
