import { dailyBudgetBytes, withLinkImportMeter } from '../../src/lib/api-keys/anonymous-upload-budget';
import type { Plan } from '../../src/lib/plan-limits';

/** The deadline of the imports these helpers stand in for: the default of the synchronous route. */
const IMPORT_DEADLINE_MS = 120_000;

/** Uses `bytes` of the day's link-import budget of `owner` on `plan`, as an import that received them would. */
export async function spendImportBytes(owner: string, plan: Plan, bytes: number): Promise<void> {
  const spent = await withLinkImportMeter({ owner, plan, limitBytes: dailyBudgetBytes(plan), deadlineMs: IMPORT_DEADLINE_MS }, (meter) => meter.count(bytes));
  if ('refusal' in spent) throw new Error(`the import budget of ${owner} is already spent`);
}
