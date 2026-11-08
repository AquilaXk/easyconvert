import type { AppLocale } from '@/i18n/routing';

export type AuthMailKind = 'reset' | 'verify';

export interface AuthMail {
  subject: string;
  /** Plain text only: no HTML part, no remote image, no tracked link. */
  text: string;
}

/** Minutes a password reset link works; the store keeps the token for exactly this long. */
export const RESET_TOKEN_TTL_MINUTES = 10;
/** Hours an email verification link works. */
export const VERIFY_TOKEN_TTL_HOURS = 24;

const MAIL: Record<AuthMailKind, Record<AppLocale, (link: string) => AuthMail>> = {
  reset: {
    en: (link) => ({
      subject: 'Reset your EasyConvert password',
      text: [
        'Someone asked to reset the password of your EasyConvert account.',
        '',
        `Open this link within ${RESET_TOKEN_TTL_MINUTES} minutes to choose a new password:`,
        link,
        '',
        'The link works once. If you did not ask for this, ignore this mail: your password stays as it is.',
        '',
      ].join('\n'),
    }),
    ko: (link) => ({
      subject: 'EasyConvert 비밀번호를 다시 설정해 주세요',
      text: [
        'EasyConvert 계정의 비밀번호를 다시 설정해 달라는 요청이 있었어요.',
        '',
        `${RESET_TOKEN_TTL_MINUTES}분 안에 아래 링크를 열어 새 비밀번호를 정해 주세요.`,
        link,
        '',
        '링크는 한 번만 쓸 수 있어요. 요청하지 않았다면 이 메일을 무시해 주세요. 비밀번호는 그대로예요.',
        '',
      ].join('\n'),
    }),
  },
  verify: {
    en: (link) => ({
      subject: 'Confirm your EasyConvert email address',
      text: [
        'Confirm this email address for your EasyConvert account.',
        '',
        `Open this link within ${VERIFY_TOKEN_TTL_HOURS} hours:`,
        link,
        '',
        'The link works once. If you did not create this account, ignore this mail.',
        '',
      ].join('\n'),
    }),
    ko: (link) => ({
      subject: 'EasyConvert 이메일 주소를 확인해 주세요',
      text: [
        'EasyConvert 계정에 쓴 이메일 주소를 확인해 주세요.',
        '',
        `${VERIFY_TOKEN_TTL_HOURS}시간 안에 아래 링크를 열어 주세요.`,
        link,
        '',
        '링크는 한 번만 쓸 수 있어요. 계정을 만들지 않았다면 이 메일을 무시해 주세요.',
        '',
      ].join('\n'),
    }),
  },
};

export function renderAuthMail(kind: AuthMailKind, locale: AppLocale, link: string): AuthMail {
  return MAIL[kind][locale](link);
}
