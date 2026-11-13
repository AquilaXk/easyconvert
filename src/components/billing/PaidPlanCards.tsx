'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useViewerAccount } from '@/hooks/useViewerPlan';
import { PAID_PLANS, isPaidPlan, type PaidPlan, type PublicBillingConfig } from '@/lib/billing/types';
import { PLAN_CONCURRENCY, PLAN_MAX_FILE_BYTES, PLAN_PROCESSING_MINUTES, TIER_LIMITS } from '@/lib/plan-limits';
import { refreshViewerPlan } from '@/lib/viewer-plan';
import { useBillingErrorWording } from '../i18n/error-wording';
import { useFormatBytes, useTierLabel } from '../i18n/format';
import { openBillingPortal } from './billing-status';
import { onCheckoutCompleted, openCheckout, previewPrice, type PlanPrice } from './paddle-checkout';

/** How long after a paid checkout the page asks for the session again: the plan changes when Paddle's event arrives. */
const PLAN_REFRESH_DELAY_MS = 5000;

const BUTTON =
  'mt-5 min-h-[44px] inline-flex items-center justify-center self-start px-5 text-sm font-semibold rounded-sm bg-accent text-on-accent hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50';

function usePlanPrice(status: PublicBillingConfig | undefined, plan: PaidPlan): PlanPrice | undefined {
  const [price, setPrice] = useState<PlanPrice>();
  const priceId = status?.plans.find((entry) => entry.plan === plan)?.priceId;
  useEffect(() => {
    if (!status || !priceId) return;
    let current = true;
    previewPrice(status, priceId).then(
      (preview) => {
        if (current) setPrice(preview);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [status, priceId]);
  return price;
}

function PlanButton({ plan, status }: Readonly<{ plan: PaidPlan; status: PublicBillingConfig | null }>) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const wording = useBillingErrorWording();
  const account = useViewerAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (status === null) {
    return (
      <button type="button" disabled aria-disabled="true" className={BUTTON}>
        {t('comingSoon')}
      </button>
    );
  }
  if (account === null) {
    return (
      <Link href="/auth" className={BUTTON}>
        {t('signInToSubscribe')}
      </Link>
    );
  }
  if (account.tier === plan) {
    return (
      <button type="button" disabled aria-disabled="true" className={BUTTON}>
        {t('currentPlan')}
      </button>
    );
  }

  async function run(action: () => Promise<{ payload: unknown; status: number } | undefined>) {
    setBusy(true);
    setError(undefined);
    try {
      const refusal = await action();
      if (refusal) setError(wording(refusal.payload, refusal.status, t('manage')));
    } finally {
      setBusy(false);
    }
  }

  const subscribe = () =>
    run(async () => {
      const res = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan }),
      });
      const payload = (await res.json().catch(() => null)) as { checkout?: Parameters<typeof openCheckout>[1] } | null;
      if (!res.ok || !payload?.checkout) return { payload, status: res.status };
      return (await openCheckout(status, payload.checkout, locale)) ? undefined : { payload: null, status: 502 };
    });
  const paid = isPaidPlan(account.tier);
  const label = paid ? t('manage') : t('subscribe');

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void (paid ? run(openBillingPortal) : subscribe())} className={BUTTON}>
        {busy ? t('starting') : label}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

function PaidPlanCard({ plan, status }: Readonly<{ plan: PaidPlan; status: PublicBillingConfig | null }>) {
  const t = useTranslations('billing');
  const tierLabel = useTierLabel();
  const formatBytes = useFormatBytes();
  const price = usePlanPrice(status ?? undefined, plan);
  const headingId = `${plan}-plan-heading`;

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-rule bg-surface p-6 sm:p-8 md:p-6 flex flex-col">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-xl text-ink">
          {tierLabel(plan)}
        </h2>
        {status === null ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-bold bg-accent-soft text-accent-ink border border-accent-edge">
            {t('comingSoon')}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-3 md:min-h-12">{t(`plans.${plan}.tagline`)}</p>
      <p className="mt-4 min-h-9 text-3xl font-semibold text-ink">{price ? t(`price.${price.interval ?? 'other'}`, { price: price.formatted }) : null}</p>
      <PlanButton plan={plan} status={status} />
      <ul className="mt-8 space-y-2">
        {[
          t('limits.monthly', { count: TIER_LIMITS[plan] }),
          t('limits.fileSize', { size: formatBytes(PLAN_MAX_FILE_BYTES[plan]) }),
          t('limits.concurrent', { count: PLAN_CONCURRENCY[plan] }),
          t('limits.processing', { minutes: PLAN_PROCESSING_MINUTES[plan] }),
          t('limits.inheritsFree'),
        ].map((line) => (
          <li key={line} className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The paid plans of the pricing page. `billing` is what the server read when it rendered the page: null while paid plans are not
 * on sale, when each plan reads "coming soon" with a disabled button; else each plan offers a checkout (Paddle.js is loaded only
 * then), or a sign-in, or its own management.
 */
export default function PaidPlanCards({ billing }: Readonly<{ billing: PublicBillingConfig | null }>) {
  const t = useTranslations('billing');
  const [completed, setCompleted] = useState(false);

  useEffect(
    () =>
      onCheckoutCompleted(() => {
        setCompleted(true);
        setTimeout(() => void refreshViewerPlan(), PLAN_REFRESH_DELAY_MS);
      }),
    []
  );

  return (
    <>
      {PAID_PLANS.map((plan) => (
        <PaidPlanCard key={plan} plan={plan} status={billing} />
      ))}
      {completed ? (
        <p role="status" className="col-span-full text-sm text-ink-2">
          {t('completed')}
        </p>
      ) : null}
    </>
  );
}
