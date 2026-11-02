import { dailyBudgetBytes, withLinkImportMeter } from '../../src/lib/api-keys/anonymous-upload-budget';
import type { Plan } from '../../src/lib/plan-limits';

/** Uses `bytes` of the day's link-import budget of `owner` on `plan`, as an import that received them would. */
export async function spendImportBytes(owner: string, plan: Plan, bytes: number): Promise<void> {
  const spent = await withLinkImportMeter({ owner, plan, limitBytes: dailyBudgetBytes(plan) }, (meter) => meter.count(bytes));
  if ('refusal' in spent) throw new Error(`the import budget of ${owner} is already spent`);
}
