import React from 'react';
import { useTranslations } from 'next-intl';

/** The sections of each policy page, in order; each one's heading and body are `infoPages.<page>.<section>`. */
const POLICY_SECTIONS = {
  privacy: ['retention', 'isolation', 'noResale'],
  terms: ['acceptance', 'acceptableUse', 'availability'],
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
                  href="mailto:support@easyconvert.com?subject=Accessibility%20Feedback"
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

export function ContactContent() {
  const t = useTranslations('infoPages.contact');
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-xl text-ink">{t('heading')}</h2>
        <p>{t('intro')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
        <div className="p-5 rounded-md border border-rule space-y-2">
          <h3 className="font-bold text-ink text-sm">{t('email.heading')}</h3>
          <p className="text-xs text-ink-2">{t('email.body')}</p>
          <a
            href="mailto:support@easyconvert.com"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-accent-ink hover:underline rounded-md"
          >
            support@easyconvert.com
          </a>
        </div>

        <div className="p-5 rounded-md border border-rule space-y-2">
          <h3 className="font-bold text-ink text-sm">{t('bugs.heading')}</h3>
          <p className="text-xs text-ink-2">{t('bugs.body')}</p>
          <a
            href="mailto:support@easyconvert.com?subject=Bug%20Report"
            className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-accent-ink hover:underline rounded-md"
          >
            {t('bugs.link')}
          </a>
        </div>
      </div>
    </div>
  );
}
