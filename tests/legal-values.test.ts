import { describe, expect, it } from 'vitest';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '../src/lib/legal/documents';
import { LEGAL_TEXTS } from '../src/lib/legal/texts';
import { ANONYMOUS_DAILY_CONVERSIONS, FREE_DAILY_CONVERSIONS } from '../src/lib/plan-limits';
import { readIntegerSetting, GONE_RECORD_MS, JOB_INPUT_HOLD_MAX_MS } from '../src/lib/storage/result-retention';
import { JOB_STAGING_MAX_AGE_MS } from '../src/lib/storage/temp-file';
import { endedJobRetentionMs } from '../src/lib/queue/enqueue';
import { WEBHOOK_DLQ_RETENTION_MS } from '../src/lib/api-keys/webhook-dispatcher';
import { TOKEN_BUCKET_TTL_SECONDS } from '../src/lib/api-keys/redis-key-store';
import { RECORD_TTL_MS as UPLOAD_BUDGET_TTL_MS } from '../src/lib/api-keys/upload-budget-store';
import { LOGIN_WINDOW_SECONDS } from '../src/lib/auth/login-rate-limiter';
import { OAUTH_STATE_TTL_SECONDS } from '../src/lib/auth/oauth';
import { createSessionCookie } from '../src/lib/auth/session';
import { MAX_SESSION_AGE_MS } from '../src/lib/edge/opfs/storage-gc';

/**
 * The numbers the legal texts state are the values the code runs with: each phrase below is built from the value it names,
 * so a change of a default or a limit fails here until both languages say the new value. The two languages also carry the
 * same clauses: the same sections, list items and table rows.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const NO_ENV = {};

type Unit = 'minute' | 'hour' | 'day';
const UNIT_MS: Record<Unit, number> = { minute: MINUTE_MS, hour: HOUR_MS, day: DAY_MS };
const KO_UNIT: Record<Unit, string> = { minute: '분', hour: '시간', day: '일' };

/** `ms` as a whole number of `unit`; a value that is not one fails, since the texts state whole units. */
function count(ms: number, unit: Unit): number {
  expect(ms % UNIT_MS[unit], `${ms} ms in whole ${unit}s`).toBe(0);
  return ms / UNIT_MS[unit];
}
const en = (ms: number, unit: Unit) => `${count(ms, unit)} ${unit}${count(ms, unit) === 1 ? '' : 's'}`;
const ko = (ms: number, unit: Unit) => `${count(ms, unit)}${KO_UNIT[unit]}`;

const sessionMaxAgeMs = Number(/Max-Age=(\d+)/.exec(createSessionCookie('token'))?.[1]) * 1000;
const deliveredGraceMs = readIntegerSetting(NO_ENV, 'RESULT_DELIVERED_GRACE_SECONDS') * 1000;
const undeliveredTtlMs = readIntegerSetting(NO_ENV, 'RESULT_UNDELIVERED_TTL_SECONDS') * 1000;

/** What each value is, and the phrase that states it in the privacy policy in each language. */
const PRIVACY_VALUES: ReadonlyArray<{ value: string; en: string; ko: string }> = [
  { value: 'upload kept after its last conversion (RESULT_DELIVERED_GRACE_SECONDS)', en: `Deleted ${en(deliveredGraceMs, 'minute')} after the last conversion that reads it ends`, ko: `마지막 변환이 끝나고 ${ko(deliveredGraceMs, 'minute')} 뒤 삭제합니다` },
  { value: 'unused upload (JOB_INPUT_HOLD_MAX_MS)', en: `deleted after at most ${en(JOB_INPUT_HOLD_MAX_MS, 'day')}`, ko: `길어도 ${ko(JOB_INPUT_HOLD_MAX_MS, 'day')} 뒤 삭제합니다` },
  { value: 'delivered result (RESULT_DELIVERED_GRACE_SECONDS)', en: `Deleted ${en(deliveredGraceMs, 'minute')} after its first complete download`, ko: `처음으로 끝까지 내려받은 때부터 ${ko(deliveredGraceMs, 'minute')} 뒤` },
  { value: 'undelivered result (RESULT_UNDELIVERED_TTL_SECONDS)', en: `or ${en(undeliveredTtlMs, 'hour')} after it was made`, ko: `내려받지 않으면 만든 때부터 ${ko(undeliveredTtlMs, 'hour')} 뒤` },
  { value: 'temporary files (JOB_STAGING_MAX_AGE_MS)', en: `at the latest ${en(JOB_STAGING_MAX_AGE_MS, 'hour')} after the conversion started`, ko: `늦어도 ${ko(JOB_STAGING_MAX_AGE_MS, 'hour')} 뒤 삭제합니다` },
  { value: 'ended job (endedJobRetentionMs)', en: `Deleted ${en(endedJobRetentionMs(NO_ENV), 'hour')} after the job ends: ${en(undeliveredTtlMs, 'hour')} while its result can be downloaded, then ${en(GONE_RECORD_MS, 'day')}`, ko: `작업이 끝나고 ${ko(endedJobRetentionMs(NO_ENV), 'hour')} 뒤 삭제합니다. 결과를 내려받을 수 있는 ${ko(undeliveredTtlMs, 'hour')}과, 삭제된 결과를 내려받으려 할 때 삭제되었다고 알리는 ${ko(GONE_RECORD_MS, 'day')}` },
  { value: 'failed job copy (endedJobRetentionMs)', en: `Deleted ${en(endedJobRetentionMs(NO_ENV), 'hour')} after the failure`, ko: `실패하고 ${ko(endedJobRetentionMs(NO_ENV), 'hour')} 뒤 삭제합니다` },
  { value: 'failed webhook delivery (WEBHOOK_DLQ_RETENTION_MS)', en: `Deleted ${en(WEBHOOK_DLQ_RETENTION_MS, 'day')} after the delivery failed`, ko: `전송에 실패하고 ${ko(WEBHOOK_DLQ_RETENTION_MS, 'day')} 뒤 삭제하며` },
  { value: 'request burst counters (TOKEN_BUCKET_TTL_SECONDS)', en: `| Request burst counters | ${en(TOKEN_BUCKET_TTL_SECONDS * 1000, 'hour')} after the last request. |`, ko: `| 짧은 시간 요청 횟수 기록 | 마지막 요청부터 ${ko(TOKEN_BUCKET_TTL_SECONDS * 1000, 'hour')} |` },
  { value: 'upload allowance records (upload budget RECORD_TTL_MS)', en: `| Upload allowance records | ${en(UPLOAD_BUDGET_TTL_MS, 'day')}. |`, ko: `| 업로드 한도 기록 | ${ko(UPLOAD_BUDGET_TTL_MS, 'day')} |` },
  { value: 'sign-in attempt limits (LOGIN_WINDOW_SECONDS)', en: `| Sign-in attempt limits | ${en(LOGIN_WINDOW_SECONDS * 1000, 'minute')}. |`, ko: `| 로그인 시도 제한 기록 | ${ko(LOGIN_WINDOW_SECONDS * 1000, 'minute')} |` },
  { value: 'session cookie (Max-Age)', en: `| \`easyconvert_session\` | Keeps you signed in | ${en(sessionMaxAgeMs, 'day')}, or until you sign out |`, ko: `| \`easyconvert_session\` | 로그인 상태 유지 | ${ko(sessionMaxAgeMs, 'day')} 또는 로그아웃할 때까지 |` },
  { value: 'OAuth state cookie (OAUTH_STATE_TTL_SECONDS)', en: `| \`easyconvert_oauth_state\` | Protects the sign-in with Google | ${en(OAUTH_STATE_TTL_SECONDS * 1000, 'minute')} |`, ko: `| \`easyconvert_oauth_state\` | Google 로그인 보호 | ${ko(OAUTH_STATE_TTL_SECONDS * 1000, 'minute')} |` },
  { value: 'browser session files (MAX_SESSION_AGE_MS)', en: `once they are ${en(MAX_SESSION_AGE_MS, 'hour')} old`, ko: `${ko(MAX_SESSION_AGE_MS, 'hour')}이 지난 뒤` },
];

describe('the numbers of the legal texts are the values in force', () => {
  it.each(PRIVACY_VALUES)('the privacy policy states the $value', ({ en: english, ko: korean }) => {
    expect(LEGAL_TEXTS.privacy.en).toContain(english);
    expect(LEGAL_TEXTS.privacy.ko).toContain(korean);
  });

  it('the terms state the daily allowance without an account and on the free plan', () => {
    expect(ANONYMOUS_DAILY_CONVERSIONS).toBe(FREE_DAILY_CONVERSIONS);
    expect(LEGAL_TEXTS.terms.en).toContain(`Without an account and on the free plan, you can run ${FREE_DAILY_CONVERSIONS} conversions on our servers per day.`);
    expect(LEGAL_TEXTS.terms.ko).toContain(`하루에 서버 변환을 ${FREE_DAILY_CONVERSIONS}회까지`);
  });
});

/** The clauses of a Markdown text: its sections, list items and table rows. */
function clauses(markdown: string) {
  const lines = markdown.split('\n');
  return {
    sections: lines.filter((line) => line.startsWith('## ')).length,
    items: lines.filter((line) => line.startsWith('- ')).length,
    rows: lines.filter((line) => line.startsWith('|')).length,
    paragraphs: lines.filter((line) => /^[^\s#|-]/.test(line)).length,
  };
}

describe('the two languages of each legal text', () => {
  it.each(Object.keys(LEGAL_DOCUMENTS) as LegalDocumentId[])('%s has the same sections, list items, table rows and paragraphs in both', (id) => {
    expect(clauses(LEGAL_TEXTS[id].ko)).toEqual(clauses(LEGAL_TEXTS[id].en));
  });
});
