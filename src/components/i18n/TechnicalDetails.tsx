'use client';

import { useTranslations } from 'next-intl';

/**
 * The server's English text of an error, closed under "technical details" below the sentence in the page's language, so
 * nothing is lost for support. A native disclosure: it opens from the keyboard and reads its state to screen readers.
 */
export default function TechnicalDetails({ text }: Readonly<{ text?: string }>) {
  const t = useTranslations('errors');
  if (!text) return null;
  return (
    <details className="mt-1 text-xs text-ink-2">
      <summary className="cursor-pointer py-1 hover:text-ink">
        {t('technicalDetails')}
      </summary>
      <p lang="en" className="mt-1 font-mono break-words">
        {text}
      </p>
    </details>
  );
}
