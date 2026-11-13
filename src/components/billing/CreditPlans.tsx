'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useViewerAccount } from '@/hooks/useViewerPlan';
import { PACKAGE_SIZES, SUBSCRIPTION_SIZES, type PackageSize, type Product, type SubscriptionSize } from '@/lib/billing/credits';
import type { PublicBillingConfig } from '@/lib/billing/types';
import { PLAN_CONCURRENCY, PLAN_MAX_FILE_BYTES, PLAN_PROCESSING_MINUTES } from '@/lib/plan-limits';
import { refreshViewerPlan } from '@/lib/viewer-plan';
import { useBillingErrorWording } from '../i18n/error-wording';
import { useFormatBytes } from '../i18n/format';
import { openBillingPortal, useBillingStatus } from './billing-status';
import { onCheckoutCompleted, openCheckout, previewPrices, type PlanPrice } from './paddle-checkout';

/** How long after a paid checkout the page asks for the session again: the credits arrive when Paddle's event does. */
const PLAN_REFRESH_DELAY_MS = 5000;

/** The volumes the selector steps over: every size a package or a subscription is sold in. */
const VOLUMES = [...new Set<number>([...PACKAGE_SIZES, ...SUBSCRIPTION_SIZES])].sort((a, b) => a - b);
const DEFAULT_VOLUME = 1000;

const BUTTON =
  'mt-5 min-h-[44px] inline-flex items-center justify-center self-start px-5 text-sm font-semibold rounded-sm bg-accent text-on-accent hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50';
const CARD = 'rounded-md border border-rule bg-surface p-6 sm:p-8 md:p-6 flex flex-col';

/** The subscription size a volume buys: the smallest subscription is larger than the smallest package, so that volume takes the smallest one. */
const subscriptionSizeOf = (volume: number): SubscriptionSize => SUBSCRIPTION_SIZES.find((size) => size >= volume) ?? SUBSCRIPTION_SIZES[SUBSCRIPTION_SIZES.length - 1];

/** The prices Paddle gives this visitor for every package and subscription on sale, by price id; empty until they arrive. */
function usePrices(status: PublicBillingConfig | null): Record<string, PlanPrice> {
  const [prices, setPrices] = useState<Record<string, PlanPrice>>({});
  useEffect(() => {
    if (!status) return;
    let current = true;
    previewPrices(status, [...status.packages, ...status.subscriptions].map((entry) => entry.priceId)).then(
      (preview) => {
        if (current) setPrices(preview);
      },
      () => undefined
    );
    return () => {
      current = false;
    };
  }, [status]);
  return prices;
}

function VolumeSelector({ volume, onChange }: Readonly<{ volume: number; onChange: (volume: number) => void }>) {
  const t = useTranslations('billing.volume');
  const format = useFormatter();
  return (
    <fieldset className="mb-6">
      <legend className="text-sm font-semibold text-ink">{t('label')}</legend>
      <p className="mt-1 text-sm text-ink-3">{t('hint')}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {VOLUMES.map((step) => (
          <label key={step} className="relative">
            <input type="radio" name="credit-volume" value={step} checked={step === volume} onChange={() => onChange(step)} className="peer sr-only" />
            <span className="inline-flex min-h-[44px] min-w-[4.5rem] cursor-pointer items-center justify-center rounded-sm border border-rule px-4 text-sm font-semibold text-ink-2 hover:border-accent peer-checked:border-accent peer-checked:bg-accent peer-checked:text-on-accent peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent">
              {format.number(step)}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The limits a paid account has, whatever it bought: one list for the package and the subscription. */
function usePaidLimitLines(): string[] {
  const t = useTranslations('billing.limits');
  const formatBytes = useFormatBytes();
  return [
    t('fileSize', { size: formatBytes(PLAN_MAX_FILE_BYTES.paid) }),
    t('concurrent', { count: PLAN_CONCURRENCY.paid }),
    t('processing', { minutes: PLAN_PROCESSING_MINUTES.paid }),
    t('priority'),
  ];
}

function FeatureList({ lines }: Readonly<{ lines: readonly string[] }>) {
  return (
    <ul className="mt-8 space-y-2">
      {lines.map((line, index) => (
        <li key={index} className="flex gap-2.5 text-sm leading-relaxed text-ink-2">
          <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

/** The price of a product and what a credit of it costs, or nothing until Paddle has answered. */
function PriceLines({ price, credits, once }: Readonly<{ price: PlanPrice | undefined; credits: number; once: boolean }>) {
  const t = useTranslations('billing');
  const locale = useLocale();
  if (!price) return <p className="mt-4 min-h-9 text-3xl font-semibold text-ink" />;
  const perCredit = new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency, minimumFractionDigits: 3, maximumFractionDigits: 4 }).format(price.amount / credits);
  return (
    <>
      <p className="mt-4 min-h-9 text-3xl font-semibold text-ink">{t(once ? 'price.once' : `price.${price.interval ?? 'other'}`, { price: price.formatted })}</p>
      <p className="mt-1 text-sm text-ink-3">{t('perCredit', { price: perCredit })}</p>
    </>
  );
}

/** Runs a billing step that may refuse, keeping its error for the card that started it. */
function useBillingAction() {
  const t = useTranslations('billing');
  const wording = useBillingErrorWording();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
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
  return { busy, error, run };
}

type CheckoutAnswer = { checkout?: Parameters<typeof openCheckout>[1]; changed?: boolean } | null;

/** Asks the server for the checkout of `product` and opens it, or reports that the subscription was changed. */
async function startCheckout(status: PublicBillingConfig, product: Product, locale: string): Promise<{ payload: unknown; status: number } | 'changed' | undefined> {
  const res = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(product) });
  const payload = (await res.json().catch(() => null)) as CheckoutAnswer;
  if (!res.ok) return { payload, status: res.status };
  if (payload?.changed) return 'changed';
  if (!payload?.checkout) return { payload, status: res.status };
  return (await openCheckout(status, payload.checkout, locale)) ? undefined : { payload: null, status: 502 };
}

function ProductButton({ product, status, current }: Readonly<{ product: Product; status: PublicBillingConfig | null; current?: 'same' | 'other' }>) {
  const t = useTranslations('billing');
  const locale = useLocale();
  const account = useViewerAccount();
  const { busy, error, run } = useBillingAction();
  const [switched, setSwitched] = useState(false);

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
        {t(product.kind === 'package' ? 'signInToBuy' : 'signInToSubscribe')}
      </Link>
    );
  }
  if (current === 'same') {
    return (
      <button type="button" disabled aria-disabled="true" className={BUTTON}>
        {t('currentPlan')}
      </button>
    );
  }

  const label = product.kind === 'package' ? t('buyPackage') : current === 'other' ? t('switchTo') : t('subscribe');
  const buy = () =>
    run(async () => {
      const result = await startCheckout(status, product, locale);
      if (result === 'changed') setSwitched(true);
      return result === 'changed' ? undefined : result;
    });

  return (
    <>
      <button type="button" disabled={busy} onClick={() => void buy()} className={BUTTON}>
        {busy ? t('starting') : label}
      </button>
      {switched ? (
        <p role="status" className="mt-2 text-sm text-ink-2">
          {t('switched')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

function ComingSoonBadge({ status }: Readonly<{ status: PublicBillingConfig | null }>) {
  const t = useTranslations('billing');
  if (status !== null) return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-bold bg-accent-soft text-accent-ink border border-accent-edge">
      {t('comingSoon')}
    </span>
  );
}

function PackageCard({ credits, status, price }: Readonly<{ credits: PackageSize; status: PublicBillingConfig | null; price: PlanPrice | undefined }>) {
  const t = useTranslations('billing');
  const paidLimits = usePaidLimitLines();
  return (
    <section aria-labelledby="package-plan-heading" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="package-plan-heading" className="text-xl text-ink">
          {t('package.name')}
        </h2>
        <ComingSoonBadge status={status} />
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-3 md:min-h-12">{t('package.tagline')}</p>
      <p className="mt-4 text-sm font-semibold text-ink">{t('package.credits', { credits })}</p>
      <PriceLines price={price} credits={credits} once />
      <ProductButton product={{ kind: 'package', credits }} status={status} />
      <FeatureList lines={[t('package.never'), t('package.after'), ...paidLimits]} />
    </section>
  );
}

function SubscriptionCard({ volume, status, prices }: Readonly<{ volume: number; status: PublicBillingConfig | null; prices: Record<string, PlanPrice> }>) {
  const t = useTranslations('billing');
  const account = useViewerAccount();
  const paidLimits = usePaidLimitLines();
  const credits = subscriptionSizeOf(volume);
  const priceId = status?.subscriptions.find((entry) => entry.credits === credits)?.priceId;
  return (
    <section aria-labelledby="subscription-plan-heading" className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="subscription-plan-heading" className="text-xl text-ink">
          {t('subscription.name')}
        </h2>
        <ComingSoonBadge status={status} />
      </div>
      <p className="mt-1 text-sm leading-relaxed text-ink-3 md:min-h-12">{t('subscription.tagline')}</p>
      <p className="mt-4 text-sm font-semibold text-ink">{t('subscription.credits', { credits })}</p>
      {credits !== volume ? <p className="mt-1 text-xs text-ink-3">{t('subscription.startsAt', { credits: SUBSCRIPTION_SIZES[0] })}</p> : null}
      <PriceLines price={priceId ? prices[priceId] : undefined} credits={credits} once={false} />
      {account === null || status === null ? <ProductButton product={{ kind: 'subscription', credits }} status={status} /> : <SubscriberButton credits={credits} status={status} />}
      <FeatureList lines={[t('subscription.noRollover'), t('subscription.cancel'), ...paidLimits]} />
    </section>
  );
}

/** The button of a signed-in account: which size it holds decides whether this one is its subscription, a switch, or a first purchase. */
function SubscriberButton({ credits, status }: Readonly<{ credits: SubscriptionSize; status: PublicBillingConfig }>) {
  const t = useTranslations('billing');
  const billing = useBillingStatus();
  const { busy, error, run } = useBillingAction();
  const held = billing?.enabled ? billing.subscription : null;
  const holds = held?.active ? held.credits : undefined;
  if (holds === undefined) return <ProductButton product={{ kind: 'subscription', credits }} status={status} />;
  if (holds !== credits) return <ProductButton product={{ kind: 'subscription', credits }} status={status} current="other" />;
  return (
    <>
      <button type="button" disabled={busy} onClick={() => void run(openBillingPortal)} className={BUTTON}>
        {t('manage')}
      </button>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}

function EnterpriseCard() {
  const t = useTranslations('billing.enterprise');
  return (
    <section aria-labelledby="enterprise-plan-heading" className={CARD}>
      <h2 id="enterprise-plan-heading" className="text-xl text-ink">
        {t('name')}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-3 md:min-h-12">{t('tagline')}</p>
      <p className="mt-4 min-h-9 text-3xl font-semibold text-ink">{t('price')}</p>
      <p className="mt-1 text-sm text-ink-3">{t('body')}</p>
      <Link href="/contact" className={BUTTON}>
        {t('contact')}
      </Link>
    </section>
  );
}

/**
 * The plans of the pricing page: a volume selector and the free plan (`freeCard`, rendered by the server), a package and a subscription
 * of the chosen volume, and Enterprise, which is contact only. `billing` is what the server read when it rendered the page: null while
 * nothing is on sale, when each product reads "coming soon" with a disabled button; else each product offers a checkout (Paddle.js is
 * loaded only then, for the prices), or a sign-in.
 */
export default function CreditPlans({ billing, freeCard }: Readonly<{ billing: PublicBillingConfig | null; freeCard: ReactNode }>) {
  const t = useTranslations('billing');
  const [volume, setVolume] = useState<number>(DEFAULT_VOLUME);
  const [completed, setCompleted] = useState(false);
  const prices = usePrices(billing);
  const packageSize = PACKAGE_SIZES.find((size) => size === volume) ?? PACKAGE_SIZES[0];
  const packagePriceId = billing?.packages.find((entry) => entry.credits === packageSize)?.priceId;

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
      <VolumeSelector volume={volume} onChange={setVolume} />
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 md:items-start">
        {freeCard}
        <PackageCard credits={packageSize} status={billing} price={packagePriceId ? prices[packagePriceId] : undefined} />
        <SubscriptionCard volume={volume} status={billing} prices={prices} />
        <EnterpriseCard />
      </div>
      {completed ? (
        <p role="status" className="mt-4 text-sm text-ink-2">
          {t('completed')}
        </p>
      ) : null}
    </>
  );
}
