import type { QuotaUsage, UserConversionFile } from '@/lib/api-keys/types';
import type { PublicApiKey, PublicWebhookDlqEntry } from '@/lib/api-keys/public-views';
import type { User } from '@/lib/auth/types';

/** A converted file of the account with the seconds it stays, as the files route and the dashboard list it. */
export interface AccountFile extends UserConversionFile {
  remainingSeconds: number;
}

/**
 * What the server hands the dashboard for its first paint: the signed-in person and what the dashboard would otherwise read
 * after hydration. A part that could not be read is left out, and the page reads that part itself as it did before.
 */
export interface DashboardSnapshot {
  user: User;
  keys?: PublicApiKey[];
  quota?: QuotaUsage;
  files?: AccountFile[];
  dlqEntries?: PublicWebhookDlqEntry[];
}
