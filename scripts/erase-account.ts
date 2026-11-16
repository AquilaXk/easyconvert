import { isEntitlingStatus } from '../src/lib/billing/entitlement';
import {
  deleteKeysInBatches,
  eraseAccount,
  MAX_ERASURE_JOBS_PER_RUN,
  planAccountErasure,
  type AccountErasureOptions,
  type AccountErasureOutcome,
  type AccountErasurePlan,
} from '../src/lib/auth/erase-account';

export {
  deleteKeysInBatches,
  eraseAccount,
  planAccountErasure,
  type AccountErasureOptions,
  type AccountErasureOutcome,
  type AccountErasurePlan,
};

/** The subscription record is deleted here; the payment provider keeps the customer and keeps charging an active subscription until it is canceled there. */
function subscriptionLines({ subscription }: AccountErasurePlan): string[] {
  if (!subscription) return [];
  const warning = isEntitlingStatus(subscription.status)
    ? `  WARNING: the subscription is ${subscription.status}; cancel ${subscription.providerSubscriptionId} at the payment provider first, or it keeps charging the customer`
    : '  the customer stays at the payment provider';
  return [`subscription record: ${subscription.providerSubscriptionId} (${subscription.status})`, warning];
}

function describe(plan: AccountErasurePlan): string {
  return [
    `account ${plan.userId} (${plan.email})`,
    `api keys: ${plan.apiKeyIds.length}`,
    `storage credentials: ${plan.credentialIds.length}`,
    `graphs: ${plan.graphIds.length}`,
    `jobs: ${plan.jobs.length}${plan.jobs.length === MAX_ERASURE_JOBS_PER_RUN ? ' (the first batch; run again)' : ''}`,
    `open resumable uploads: ${plan.tusSessionIds.length}`,
    `open multipart uploads: ${plan.uploadSessionIds.length}`,
    `stored files: ${plan.storedKeys.length}`,
    `webhook dead letters: ${plan.deadLetters}`,
    ...subscriptionLines(plan),
    ...(plan.packageCredits > 0 ? [`package credits: ${plan.packageCredits} (deleted with the account)`] : []),
    `tagged redis keys: ${plan.taggedKeys.length}`,
    ...plan.taggedKeys.map((key) => `  ${key}`),
  ].join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  const userAt = argv.indexOf('--user');
  const idOrEmail = userAt >= 0 ? argv[userAt + 1] : undefined;
  if (!idOrEmail) {
    console.error('Usage: erase-account --user <account id or email> [--apply]');
    return 2;
  }
  const plan = await planAccountErasure(idOrEmail);
  if (!plan) {
    console.error(`No account ${idOrEmail}.`);
    return 1;
  }
  console.log(describe(plan));
  if (!argv.includes('--apply')) {
    console.log('Dry run: nothing was deleted. Run again with --apply to delete.');
    return 0;
  }
  const { runningJobIds } = await eraseAccount(plan);
  if (runningJobIds.length > 0) {
    console.log(`${runningJobIds.length} job(s) are not removed yet (still running, or queued after this run looked): run again once they stop.`);
    return 3;
  }
  console.log('Deleted.');
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    }
  );
}
