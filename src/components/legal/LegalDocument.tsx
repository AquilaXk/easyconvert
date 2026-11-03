import React from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { AppLocale } from '@/i18n/routing';
import { LEGAL_DOCUMENTS, type LegalDocumentId } from '@/lib/legal/documents';
import { readLegalPage } from '@/lib/legal/render';
import { LEGAL_TEXTS } from '@/lib/legal/texts';

/** Element styles of the rendered Markdown, which carries no classes of its own. */
const PROSE_CLASS = [
  'text-base leading-7 text-ink',
  '[&_p]:mt-4 [&_a]:text-accent-ink [&_a]:underline [&_strong]:font-semibold',
  '[&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:mt-1.5',
  '[&_table]:mt-4 [&_table]:w-full [&_table]:text-sm [&_table]:border-collapse',
  '[&_th]:border [&_th]:border-rule [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-rule [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
  '[&_code]:font-mono [&_code]:text-sm [&_code]:break-all',
].join(' ');

const SECTION_CLASS =
  '[&_h2]:scroll-mt-24 [&_h2]:mt-10 [&_h2]:pt-10 [&_h2]:border-t [&_h2]:border-rule [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:text-ink [&_h2:first-child]:mt-0 [&_h2:first-child]:pt-0 [&_h2:first-child]:border-t-0';

/** A legal page: its version date above the title, the introduction, then the table of contents beside the sections. */
export function LegalDocument({ id, locale }: Readonly<{ id: LegalDocumentId; locale: AppLocale }>) {
  const t = useTranslations('legal');
  const format = useFormatter();
  const { version } = LEGAL_DOCUMENTS[id];
  const page = readLegalPage(LEGAL_TEXTS[id][locale]);
  const effective = format.dateTime(new Date(`${version}T00:00:00Z`), { dateStyle: 'long', timeZone: 'UTC' });

  return (
    <article>
      <header>
        <p className="text-sm font-medium text-ink-3">
          <time dateTime={version}>{t('effective', { date: effective })}</time>
        </p>
        <h1 className="mt-2 text-3xl sm:text-4xl font-bold text-ink">{page.title}</h1>
        <div className={`${PROSE_CLASS} text-lg text-ink-2`} dangerouslySetInnerHTML={{ __html: page.introHtml }} />
      </header>

      <div className="mt-8 pt-8 border-t border-rule grid grid-cols-1 lg:grid-cols-[13rem_minmax(0,1fr)] gap-8 lg:gap-12">
        <nav aria-labelledby="legal-contents" className="lg:sticky lg:top-24 lg:self-start">
          <h2 id="legal-contents" className="text-sm font-semibold text-ink">
            {t('contents')}
          </h2>
          <ol className="mt-3 space-y-2 text-sm">
            {page.sections.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="text-ink-2 hover:text-accent-ink">
                  {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className={`${PROSE_CLASS} ${SECTION_CLASS} min-w-0`} dangerouslySetInnerHTML={{ __html: page.bodyHtml }} />
      </div>
    </article>
  );
}
