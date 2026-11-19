/**
 * The copy of the root error boundary (`src/app/global-error.tsx`). That boundary replaces the root layout, so no message
 * provider is there to read `errorPage` from; tests/i18n-messages.test.ts keeps this table equal to the messages.
 */
export const GLOBAL_ERROR_COPY = {
  en: { title: 'Something went wrong', description: 'An unexpected error occurred while showing this page.', retry: 'Try again', home: 'Back to home' },
  ko: { title: '문제가 발생했습니다', description: '페이지를 표시하는 중 예기치 못한 오류가 발생했습니다.', retry: '다시 시도', home: '홈으로' },
} as const;
