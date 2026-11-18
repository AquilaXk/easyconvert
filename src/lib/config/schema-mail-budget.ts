import type { VariableSpec } from './schema';

const WEB = ['web'] as const;

export const AUTH_MAIL_BUDGET_ENTRIES = [
  {
    name: 'AUTH_MAIL_DAILY_WARN',
    area: 'auth',
    description: 'Daily count of authentication mails (UTC) at which the server logs a warning. Must not exceed AUTH_MAIL_DAILY_VERIFY_CAP.',
    kind: { type: 'integer', min: 1, max: 10_000_000 },
    default: 350,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'AUTH_MAIL_DAILY_VERIFY_CAP',
    area: 'auth',
    description:
      'Daily limit (UTC) on email verification mails (sign-ups and resends), leaving the headroom up to AUTH_MAIL_DAILY_HARD_CAP reserved for password resets. Raise together with AUTH_MAIL_DAILY_HARD_CAP when using a dedicated transactional SMTP service.',
    kind: { type: 'integer', min: 1, max: 10_000_000 },
    default: 400,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'AUTH_MAIL_DAILY_HARD_CAP',
    area: 'auth',
    description:
      'Total daily limit (UTC) across verification and password reset mails. Must be at least AUTH_MAIL_DAILY_VERIFY_CAP.',
    kind: { type: 'integer', min: 1, max: 10_000_000 },
    default: 480,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
] as const satisfies readonly VariableSpec[];
