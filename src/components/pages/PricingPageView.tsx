import { useTranslations } from 'next-intl';
import { ArrowRight, Check } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import PaidPlanCards from '@/components/billing/PaidPlanCards';
import { Link } from '@/i18n/navigation';
import { formatBytesForDisplay } from '@/lib/format-bytes';
import {
  DEFAULT_FREE_CONCURRENCY,
  DELIVERED_FILE_RETENTION_MINUTES,
  FREE_DAILY_CONVERSIONS,
  FREE_PROCESSING_MINUTES,
  PLAN_MAX_FILE_BYTES,
} from '@/lib/plan-limits';

const LIMIT_ROWS = ['daily', 'fileSize', 'concurrent', 'processing', 'deletion'] as const;
const FEATURE_ROWS = ['formats', 'api', 'noCard'] as const;
const FAQ_ITEMS = ['daily', 'account', 'limits', 'deletion', 'api', 'paid'] as const;

/** The free plan's limits, read from `plan-limits` so that the figures on the page are the ones the server enforces. */
function limitValues(anonymousDaily: number) {
  return {
    daily: FREE_DAILY_CONVERSIONS,
    anonymous: anonymousDaily,
    fileSize: formatBytesForDisplay(PLAN_MAX_FILE_BYTES.free),
    concurrent: DEFAULT_FREE_CONCURRENCY,
    processing: FREE_PROCESSING_MINUTES,
    deletion: DELIVERED_FILE_RETENTION_MINUTES,
  };
}

/** The pricing page: the free plan with its limits, the paid plans (coming soon until billing is configured), and the questions about them. */
export default function PricingPageView({ anonymousDaily }: Readonly<{ anonymousDaily: number }>) {
  const t = useTranslations('pricing');
  const values = limitValues(anonymousDaily);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main id="main-content" className="flex-1">
        <section className="pt-10 pb-8 lg:pt-14">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center lg:text-left">
            <h1 className="text-3xl sm:text-4xl lg:text-5xl text-ink">{t('title')}</h1>
            <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-ink-3">{t('intro')}</p>
          </div>
        </section>

        <section aria-label={t('plansLabel')} className="pb-12">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="grid gap-6 md:grid-cols-3 md:items-start">
              <section aria-labelledby="free-plan-heading" className="rounded-md border border-rule bg-surface p-6 sm:p-8 md:p-6 flex flex-col">
                <h2 id="free-plan-heading" className="text-xl text-ink">{t('plan.name')}</h2>
                <p className="mt-1 text-sm text-ink-3 md:min-h-10">{t('plan.tagline')}</p>
                <p className="mt-4 text-3xl font-semibold text-ink">{t('plan.price')}</p>
                <Link
                  href={{ pathname: '/auth', query: { tab: 'register' } }}
                  className="mt-5 min-h-[44px] inline-flex items-center justify-center self-start px-5 text-sm font-semibold rounded-sm bg-accent text-on-accent hover:opacity-90 transition-opacity"
                >
                  {t('plan.cta')}
                </Link>

                <h3 className="mt-8 text-sm font-semibold text-ink">{t('limitsHeading')}</h3>
                <dl className="mt-2 divide-y divide-rule border-y border-rule">
                  {LIMIT_ROWS.map((row) => (
                    <div key={row} className="flex items-baseline justify-between gap-4 py-2.5 text-sm">
                      <dt className="text-ink-3">{t(`limits.${row}.label`)}</dt>
                      <dd className="font-medium text-ink text-right">{t(`limits.${row}.value`, values)}</dd>
                    </div>
                  ))}
                </dl>

                <h3 className="mt-8 text-sm font-semibold text-ink">{t('includedHeading')}</h3>
                <ul className="mt-3 space-y-2">
                  {FEATURE_ROWS.map((row) => (
                    <li key={row} className="flex gap-2.5 text-sm text-ink-2">
                      <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
                      <span>{t(`features.${row}`)}</span>
                    </li>
                  ))}
                </ul>
              </section>
              <PaidPlanCards />
            </div>
          </div>
        </section>

        <section aria-labelledby="faq-heading" className="pb-14">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 id="faq-heading" className="text-2xl text-ink">{t('faqHeading')}</h2>
            <div className="mt-6 space-y-8">
              {FAQ_ITEMS.map((item) => (
                <div key={item}>
                  <h3 className="text-base font-semibold text-ink">{t(`faq.${item}.question`)}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-3">{t(`faq.${item}.answer`, values)}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="pb-16 text-center">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-2xl text-ink">{t('cta.heading')}</h2>
            <p className="mt-3 text-sm text-ink-3">{t('cta.body', values)}</p>
            <Link
              href="/"
              className="mt-5 min-h-[44px] inline-flex items-center gap-2 px-5 text-sm font-semibold rounded-sm bg-accent text-on-accent hover:opacity-90 transition-opacity"
            >
              <span>{t('cta.button')}</span>
              <ArrowRight aria-hidden="true" className="size-4" />
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
