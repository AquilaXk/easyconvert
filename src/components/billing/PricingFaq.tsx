import { useTranslations } from 'next-intl';

const FAQ_ITEMS = ['daily', 'account', 'limits', 'deletion', 'api', 'paid', 'monthly'] as const;
/** The questions that are asked only once paid plans are on sale. */
const ON_SALE_ONLY: ReadonlySet<string> = new Set(['monthly']);

/**
 * The questions of the pricing page. `onSale` is what the server read when it rendered the page: whether paid plans can be bought.
 * The answers about the file limit and about buying a plan change with it, and the question about counting a paid plan appears.
 */
export default function PricingFaq({ values, onSale }: Readonly<{ values: Record<string, number | string>; onSale: boolean }>) {
  const t = useTranslations('pricing');
  const answerOf = (item: (typeof FAQ_ITEMS)[number]): string => {
    if (item === 'monthly') return t('faq.monthly.answerOnSale', values);
    if (onSale && item === 'limits') return t('faq.limits.answerOnSale', values);
    if (onSale && item === 'paid') return t('faq.paid.answerOnSale', values);
    return t(`faq.${item}.answer`, values);
  };

  return (
    <div className="mt-6 space-y-8">
      {FAQ_ITEMS.filter((item) => onSale || !ON_SALE_ONLY.has(item)).map((item) => (
        <div key={item}>
          <h3 className="text-base font-semibold text-ink">{t(`faq.${item}.question`)}</h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-3">{answerOf(item)}</p>
        </div>
      ))}
    </div>
  );
}
