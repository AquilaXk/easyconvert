import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';

const SUPPORT_EMAIL = 'support@aquilaxk.site';

/** The sections of each policy page, in order; each one's heading and body are `infoPages.<page>.<section>`. */
const POLICY_SECTIONS = {
  about: ['purpose', 'architecture'],
  security: ['transport', 'isolation'],
  accessibility: ['conformance', 'keyboard', 'landmarks', 'contrast', 'feedback'],
} as const;

type PolicyPage = keyof typeof POLICY_SECTIONS;
type PolicySectionKey = { [P in PolicyPage]: `${P}.${(typeof POLICY_SECTIONS)[P][number]}` }[PolicyPage];

const RICH_TAGS = {
  code: (chunks: React.ReactNode) => <code>{chunks}</code>,
};

function isPolicyPage(infoType: string | undefined): infoType is PolicyPage {
  return infoType !== undefined && infoType in POLICY_SECTIONS;
}

export function PolicySections({
  infoType,
  totalFormatCount,
  dailyLimit,
}: Readonly<{ infoType: string | undefined; totalFormatCount: number; dailyLimit: number }>) {
  const t = useTranslations('infoPages');
  if (!isPolicyPage(infoType)) return null;
  const keys = POLICY_SECTIONS[infoType].map((section: string) => `${infoType}.${section}` as PolicySectionKey);

  return (
    <>
      {keys.map((key) => {
        return (
          <section key={key} className="space-y-2">
            <h2 className="text-xl text-ink">{t(`${key}.heading`)}</h2>
            <p>{t.rich(`${key}.body`, { ...RICH_TAGS, count: totalFormatCount, dailyLimit })}</p>
            {key === 'accessibility.feedback' && (
              <div>
                <a
                  href="mailto:support@aquilaxk.site?subject=Accessibility%20Feedback"
                  className="min-h-[44px] inline-flex items-center gap-1.5 text-sm font-semibold text-accent-ink hover:underline rounded-md"
                >
                  {t('accessibility.feedback.link')}
                </a>
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

export function AboutContent({ totalFormatCount, dailyLimit }: Readonly<{ totalFormatCount: number; dailyLimit: number }>) {
  const t = useTranslations('infoPages.about.contact');
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 lg:gap-12">
      <div className="lg:col-span-2 max-w-3xl space-y-6">
        <PolicySections infoType="about" totalFormatCount={totalFormatCount} dailyLimit={dailyLimit} />
      </div>
      <aside className="self-start border border-rule bg-surface p-6 space-y-3">
        <h2 className="text-base font-semibold text-ink">{t('heading')}</h2>
        <ul className="space-y-2">
          <li>
            <Link href="/contact" className="text-accent-ink hover:underline">
              {t('page')}
            </Link>
          </li>
          <li>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent-ink hover:underline break-all">
              {SUPPORT_EMAIL}
            </a>
          </li>
        </ul>
      </aside>
    </div>
  );
}

export function ContactContent() {
  const t = useTranslations('infoPages.contact');
  return (
    <div className="border border-rule bg-surface p-6 space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-semibold text-ink">{t('heading')}</h2>
        <p>{t('intro')}</p>
      </div>

      <div className="border-t border-rule pt-6 space-y-1">
        <h3 className="font-medium text-ink">{t('email.heading')}</h3>
        <p className="text-ink-3">{t('email.body')}</p>
        <a href={`mailto:${SUPPORT_EMAIL}`} className="inline-block text-accent-ink hover:underline">
          {SUPPORT_EMAIL}
        </a>
      </div>

      <div className="border-t border-rule pt-6 space-y-1">
        <h3 className="font-medium text-ink">{t('bugs.heading')}</h3>
        <p className="text-ink-3">{t('bugs.body')}</p>
        <a href={`mailto:${SUPPORT_EMAIL}?subject=Bug%20Report`} className="inline-block text-accent-ink hover:underline">
          {t('bugs.link')}
        </a>
      </div>
    </div>
  );
}
