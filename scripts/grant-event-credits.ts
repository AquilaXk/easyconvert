import fs from 'node:fs';
import { redisKeyStore } from '../src/lib/api-keys/redis-key-store';
import { PROMO_LIMITS, promoRequestRefusal, type PromoGrant } from '../src/lib/api-keys/promo-grants';
import { isEmailVerified } from '../src/lib/auth/email-verified';
import { parseOperatorCliArgs } from '../src/lib/auth/operator-cli-args';
import { redisUserStore } from '../src/lib/auth/redis-user-store';
import type { UserRecord } from '../src/lib/auth/types';

/**
 * Gives promotional (event) credits to accounts, takes them back, and reports on a campaign (docs/policy-decisions.md, entry 374). The
 * credits are a grant of the campaign: free, spent after the day's credits and before purchased credits, optionally ending at a time, and
 * out of the refund path. A dry run by default; `--apply` writes. One grant for each campaign and account, so a second run grants nobody
 * twice, and a voided grant stays on record so that it is not granted again. Only accounts with a confirmed address and without a
 * checkout hold, suspension or purge in progress receive a grant. A bulk run prints counts only, no address, and `--apply` logs one line
 * for the host's log.
 */
export const EVENT_ACTOR = 'operator-cli';
export const MAX_USERS_FILE_LINES = 200_000;

const USAGE = [
  'Usage:',
  '  grant-event-credits --campaign <id> --credits <1-' + PROMO_LIMITS.maxCredits + '> (--user <account id or email> | --users-file <path> | --all-confirmed)',
  '      [--expires <YYYY-MM-DD (end of that day, UTC) or an ISO time>] [--budget <total credits of the campaign>] [--priority <0-255>] [--reason <text>] [--apply]',
  '  grant-event-credits --void --campaign <id> [--user <account id or email> | --users-file <path>] [--apply]   (without an account: the whole campaign)',
  '  grant-event-credits --report --campaign <id>',
].join('\n');

export interface Tally {
  [counter: string]: number;
}

function add(tally: Tally, counter: string, by = 1): void {
  tally[counter] = (tally[counter] ?? 0) + by;
}

/** Why an account does not receive a grant, or undefined when it can. */
export async function ineligibility(user: UserRecord): Promise<string | undefined> {
  if (!isEmailVerified(user)) return 'email not confirmed';
  if (typeof user.purgingAt === 'number') return 'being purged';
  if (typeof user.suspendedAt === 'number') return 'suspended';
  if (await redisKeyStore.hasBillingHold(user.id)) return 'checkout hold';
  return undefined;
}

/** The time an `--expires` value names: a date alone ends at the end of that day in UTC. */
export function parseExpiry(value: string): number | undefined {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(dateOnly ? `${value}T23:59:59.999Z` : value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function findAccount(idOrEmail: string): Promise<UserRecord | null | undefined> {
  return idOrEmail.includes('@') ? redisUserStore.findByEmail(idOrEmail) : redisUserStore.findById(idOrEmail);
}

/** The accounts a run is about, a page at a time: one account, the lines of a file, or every confirmed account. */
async function* selectedAccounts(selector: { user?: string; usersFile?: string; allConfirmed: boolean }, tally: Tally): AsyncGenerator<UserRecord[]> {
  if (selector.user !== undefined) {
    const user = await findAccount(selector.user);
    if (user) yield [user];
    else add(tally, 'no such account');
    return;
  }
  if (selector.usersFile !== undefined) {
    const lines = fs.readFileSync(selector.usersFile, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
    if (lines.length > MAX_USERS_FILE_LINES) throw new Error(`The file has ${lines.length} accounts; the most a run takes is ${MAX_USERS_FILE_LINES}.`);
    for (const line of new Set(lines)) {
      const user = await findAccount(line);
      if (user) yield [user];
      else add(tally, 'no such account');
    }
    return;
  }
  for await (const page of redisUserStore.scanRecords()) yield page;
}

/** What a campaign's grants add up to at `now`. */
export interface CampaignSummary {
  accounts: number;
  granted: number;
  used: number;
  remaining: number;
  expired: number;
  voided: number;
}

/** Adds one grant to the summary: the credits it gave split into spent, spendable now, ended with credits left, and taken out by a void. */
export function addGrantToSummary(summary: CampaignSummary, grant: PromoGrant, now: number): void {
  summary.accounts += 1;
  summary.granted += grant.amount;
  if (grant.voidedAt !== undefined) {
    summary.voided += grant.voidedRemaining ?? 0;
    summary.used += grant.amount - (grant.voidedRemaining ?? 0);
  } else if (grant.expiresAt !== undefined && grant.expiresAt <= now) {
    summary.expired += grant.remaining;
    summary.used += grant.amount - grant.remaining;
  } else {
    summary.remaining += grant.remaining;
    summary.used += grant.amount - grant.remaining;
  }
}

/** Walks the accounts a campaign counts, a page at a time, and answers what each one's grant is worth. */
async function* campaignGrants(campaignId: string): AsyncGenerator<{ owner: string; grant: PromoGrant | undefined }> {
  let cursor = '0';
  do {
    const page = await redisKeyStore.promoCampaignOwners(campaignId, cursor);
    for (const owner of page.owners) {
      yield { owner, grant: (await redisKeyStore.promoGrants(owner)).find((entry) => entry.campaignId === campaignId) };
    }
    cursor = page.next;
  } while (cursor !== '0');
}

export async function summarizeCampaign(campaignId: string, now: number = Date.now()): Promise<{ summary: CampaignSummary; budget?: number; voidedAt?: number } | null> {
  const campaign = await redisKeyStore.promoCampaign(campaignId);
  if (!campaign) return null;
  const summary: CampaignSummary = { accounts: 0, granted: 0, used: 0, remaining: 0, expired: 0, voided: 0 };
  for await (const { grant } of campaignGrants(campaignId)) if (grant) addGrantToSummary(summary, grant, now);
  return { summary, ...(campaign.budget === undefined ? {} : { budget: campaign.budget }), ...(campaign.voidedAt === undefined ? {} : { voidedAt: campaign.voidedAt }) };
}

async function report(campaignId: string): Promise<number> {
  const found = await summarizeCampaign(campaignId);
  if (!found) {
    console.error(`No campaign ${campaignId}.`);
    return 1;
  }
  const { summary } = found;
  console.log(
    [
      `campaign ${campaignId}${found.voidedAt === undefined ? '' : ` (voided ${new Date(found.voidedAt).toISOString()})`}`,
      `accounts: ${summary.accounts}`,
      `granted: ${summary.granted}${found.budget === undefined ? '' : ` of a budget of ${found.budget}`}`,
      `used: ${summary.used}`,
      `remaining: ${summary.remaining}`,
      `expired: ${summary.expired}`,
      `voided: ${summary.voided}`,
    ].join('\n')
  );
  return 0;
}

interface GrantRun {
  campaignId: string;
  credits: number;
  expiresAt?: number;
  budget?: number;
  priority: number;
  reason: string;
  apply: boolean;
}

async function grantRun(run: GrantRun, selector: Parameters<typeof selectedAccounts>[0]): Promise<number> {
  const tally: Tally = {};
  const campaign = await redisKeyStore.promoCampaign(run.campaignId);
  if (campaign?.voidedAt !== undefined) {
    console.error(`Campaign ${run.campaignId} was voided; it takes no more grants.`);
    return 1;
  }
  const budget = run.budget ?? campaign?.budget;
  let budgetLeft = budget === undefined ? Number.POSITIVE_INFINITY : budget - (campaign?.granted ?? 0);
  const now = Date.now();
  let single: string | undefined;
  for await (const page of selectedAccounts(selector, tally)) {
    for (const user of page) {
      if (selector.user !== undefined) single = `${user.email} (${user.id})`;
      const refusal = await ineligibility(user);
      if (refusal) {
        add(tally, `skipped, ${refusal}`);
        continue;
      }
      const request = { campaignId: run.campaignId, amount: run.credits, priority: run.priority, reason: run.reason, actor: EVENT_ACTOR, at: now, ...(run.expiresAt === undefined ? {} : { expiresAt: run.expiresAt }) };
      if (!run.apply) {
        const held = (await redisKeyStore.promoGrants(user.id)).some((grant) => grant.campaignId === run.campaignId);
        if (held) add(tally, 'already granted');
        else if (budgetLeft < run.credits) add(tally, 'over the budget');
        else {
          budgetLeft -= run.credits;
          add(tally, 'would grant');
        }
        continue;
      }
      const outcome = await redisKeyStore.grantPromoCredits(user.id, request, run.budget);
      add(tally, outcome === 'granted' ? 'granted' : outcome === 'duplicate' ? 'already granted' : outcome === 'budget-exhausted' ? 'over the budget' : 'campaign voided');
      if (outcome === 'campaign-voided') break;
    }
  }
  if (selector.user !== undefined && tally['no such account']) {
    console.error(`No account ${selector.user}.`);
    return 1;
  }
  const expiry = run.expiresAt === undefined ? 'no expiry' : `expires ${new Date(run.expiresAt).toISOString()}`;
  console.log(`campaign ${run.campaignId}: ${run.credits} credits each, ${expiry}${budget === undefined ? '' : `, budget ${budget}`}${single ? `, ${single}` : ''}`);
  for (const [counter, count] of Object.entries(tally).sort(([a], [b]) => a.localeCompare(b))) console.log(`${counter}: ${count}`);
  if (!run.apply) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }
  console.log(`${new Date().toISOString()} grant-event-credits: campaign=${run.campaignId} credits=${run.credits} ${Object.entries(tally).map(([counter, count]) => `${counter.replace(/[ ,]+/g, '-')}=${count}`).join(' ')}`);
  return 0;
}

async function voidRun(campaignId: string, selector: Parameters<typeof selectedAccounts>[0] & { whole: boolean }, apply: boolean): Promise<number> {
  const tally: Tally = {};
  const at = Date.now();
  const take = async (userId: string) => {
    const grant = (await redisKeyStore.promoGrants(userId)).find((entry) => entry.campaignId === campaignId);
    if (!grant) return add(tally, 'no grant');
    if (grant.voidedAt !== undefined) return add(tally, 'already voided');
    if (!apply) {
      add(tally, 'would void');
      return add(tally, 'credits taken out', grant.remaining);
    }
    const outcome = await redisKeyStore.voidPromoCredits(userId, campaignId, at);
    if (outcome.status === 'voided') {
      add(tally, 'voided');
      add(tally, 'credits taken out', outcome.voided);
    } else add(tally, outcome.status);
  };
  if (selector.whole) {
    if (!(await redisKeyStore.promoCampaign(campaignId))) {
      console.error(`No campaign ${campaignId}.`);
      return 1;
    }
    if (apply) await redisKeyStore.voidPromoCampaign(campaignId, at);
    for await (const { owner } of campaignGrants(campaignId)) await take(owner);
  } else {
    for await (const page of selectedAccounts(selector, tally)) for (const user of page) await take(user.id);
  }
  console.log(`void campaign ${campaignId}${selector.whole ? ' (whole campaign)' : ''}`);
  for (const [counter, count] of Object.entries(tally).sort(([a], [b]) => a.localeCompare(b))) console.log(`${counter}: ${count}`);
  if (!apply) {
    console.log('Dry run: nothing was written. Run again with --apply to write.');
    return 0;
  }
  console.log(`${new Date().toISOString()} grant-event-credits: void campaign=${campaignId} ${Object.entries(tally).map(([counter, count]) => `${counter.replace(/[ ,]+/g, '-')}=${count}`).join(' ')}`);
  return 0;
}

export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseOperatorCliArgs(argv, {
    valueFlags: ['--campaign', '--credits', '--expires', '--user', '--users-file', '--budget', '--priority', '--reason'],
    booleanFlags: ['--all-confirmed', '--void', '--report', '--apply'],
  });
  if (!parsed.ok) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  const { values, flags } = parsed;
  const campaignId = values.get('--campaign');
  if (!campaignId || !PROMO_LIMITS.campaignIdPattern.test(campaignId)) {
    console.error(`--campaign needs an id of 1 to 64 lowercase letters, digits, dots, underscores or hyphens.\n${USAGE}`);
    return 2;
  }
  const selected = ['--user', '--users-file'].filter((flag) => values.has(flag)).length + (flags.has('--all-confirmed') ? 1 : 0);
  const apply = flags.has('--apply');

  if (flags.has('--report')) {
    if (selected > 0 || flags.has('--void') || apply) {
      console.error(USAGE);
      return 2;
    }
    return report(campaignId);
  }

  if (flags.has('--void')) {
    const whole = selected === 0;
    if (selected > 1 || flags.has('--all-confirmed') || ['--credits', '--expires', '--budget', '--priority', '--reason'].some((flag) => values.has(flag))) {
      console.error(USAGE);
      return 2;
    }
    return voidRun(campaignId, { ...(values.has('--user') ? { user: values.get('--user') as string } : {}), ...(values.has('--users-file') ? { usersFile: values.get('--users-file') as string } : {}), allConfirmed: false, whole }, apply);
  }

  if (selected !== 1 || !values.has('--credits')) {
    console.error(USAGE);
    return 2;
  }
  const credits = Number(values.get('--credits'));
  const priority = values.has('--priority') ? Number(values.get('--priority')) : 0;
  const expiresArg = values.get('--expires');
  const expiresAt = expiresArg === undefined ? undefined : parseExpiry(expiresArg);
  if (expiresArg !== undefined && expiresAt === undefined) {
    console.error('--expires needs a date (YYYY-MM-DD) or an ISO time with a zone, for example 2026-12-31 or 2026-12-31T14:59:59Z.');
    return 2;
  }
  const budgetArg = values.get('--budget');
  const budget = budgetArg === undefined ? undefined : Number(budgetArg);
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 1)) {
    console.error('--budget needs a whole number of credits above zero.');
    return 2;
  }
  const reason = values.get('--reason') ?? `event ${campaignId}`;
  const refusal = promoRequestRefusal({ campaignId, amount: credits, priority, reason, actor: EVENT_ACTOR, ...(expiresAt === undefined ? {} : { expiresAt }) }, Date.now());
  if (refusal) {
    console.error(refusal);
    return 2;
  }
  return grantRun(
    { campaignId, credits, priority, reason, apply, ...(expiresAt === undefined ? {} : { expiresAt }), ...(budget === undefined ? {} : { budget }) },
    { ...(values.has('--user') ? { user: values.get('--user') as string } : {}), ...(values.has('--users-file') ? { usersFile: values.get('--users-file') as string } : {}), allConfirmed: flags.has('--all-confirmed') }
  );
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
