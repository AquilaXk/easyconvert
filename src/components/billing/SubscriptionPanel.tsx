'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { CreditCard } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useBillingErrorWording } from '../i18n/error-wording';
import { useTierLabel } from '../i18n/format';
import { openBillingPortal, useBillingStatus, type SubscriptionView } from './billing-status';

type Translate = ReturnType<typeof useTranslations<'billing.account'>>;
type FormatDate = (milliseconds: number) => string;

/** The sentence that says where the subscription stands: when it renews, when it ends, or that it has ended. */
function stateLine(subscription: SubscriptionView, t: Translate, date: FormatDate): string | undefined {
  const { status, currentPeriodEnd, cancelAt, active } = subscription;
  if (!active) return t('ended');
  if (status === 'past_due') return currentPeriodEnd === undefined ? undefined : t('pastDue', { date: date(currentPeriodEnd) });
  if (cancelAt !== undefined) return t('endsOn', { date: date(cancelAt) });
  return currentPeriodEnd === undefined ? undefined : t('renews', { date: date(currentPeriodEnd) });
}

/**
 * The plan of the account and its subscription, on the dashboard. It appears only when paid plans are on sale: a subscriber
 * manages the payment method and the cancellation in the provider's portal, anyone else is pointed to the plans.
 */
export function SubscriptionPanel() {
  const t = useTranslations('billing.account');
  const format = useFormatter();
  const tierLabel = useTierLabel();
  const wording = useBillingErrorWording();
  const status = useBillingStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!status?.enabled) return null;

  const { subscription } = status;
  const date: FormatDate = (milliseconds) => format.dateTime(new Date(milliseconds), { year: 'numeric', month: 'short', day: 'numeric' });
  const line = subscription ? stateLine(subscription, t, date) : undefined;

  async function manage() {
    setBusy(true);
    setError(undefined);
    try {
      const refusal = await openBillingPortal();
      if (refusal) setError(wording(refusal.payload, refusal.status, t('manage')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="subscription-heading" className="p-5 rounded-md border border-rule space-y-2.5">
      <h3 id="subscription-heading" className="flex items-center gap-2 text-sm font-bold text-ink">
        <CreditCard aria-hidden="true" className="w-4 h-4 text-accent-ink" />
        {t('heading')}
      </h3>
      {subscription ? (
        <>
          <p className="text-sm text-ink">{t('plan', { plan: tierLabel(subscription.plan) })}</p>
          {line ? <p className="text-sm text-ink-2">{line}</p> : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void manage()}
            className="btn-primary min-h-[44px] inline-flex items-center px-4 py-2 rounded-sm text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {t('manage')}
          </button>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-sm text-ink-2">{t('none')}</p>
          <Link href="/pricing" className="inline-flex min-h-[44px] items-center text-sm font-semibold text-accent-ink underline underline-offset-2">
            {t('plans')}
          </Link>
        </>
      )}
    </section>
  );
}
