import { useFormatter, useTranslations } from 'next-intl';
import type { ChargeEntry } from '@/lib/api-keys/types';

type Translate = ReturnType<typeof useTranslations<'dashboard.usage.charges'>>;

/** What a charge was for: the pair of formats, a tool, a batch or a graph. */
function chargeLabel(entry: ChargeEntry, t: Translate): string {
  if (entry.kind === 'batch') return t('batch');
  if (entry.kind === 'graph') return t('graph');
  if (entry.from !== undefined && entry.to !== undefined) return t('pair', { from: entry.from.toUpperCase(), to: entry.to.toUpperCase() });
  return t('tool', { tool: entry.from ?? '' });
}

/** The account's newest charges, one row for each conversion with the credits it cost and where they came from. */
export function RecentCharges({ charges }: Readonly<{ charges: readonly ChargeEntry[] }>) {
  const t = useTranslations('dashboard.usage.charges');
  const format = useFormatter();
  return (
    <section aria-labelledby="recent-charges-heading" className="p-5 rounded-md border border-rule space-y-3">
      <h3 id="recent-charges-heading" className="text-sm font-bold text-ink">
        {t('heading')}
      </h3>
      {charges.length === 0 ? (
        <p className="text-sm text-ink-2">{t('empty')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
                <th scope="col" className="py-2 pr-4 font-semibold">{t('when')}</th>
                <th scope="col" className="py-2 pr-4 font-semibold">{t('what')}</th>
                <th scope="col" className="py-2 text-right font-semibold">{t('credits')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {charges.map((entry) => (
                <tr key={`${entry.at}-${entry.credits}-${entry.from ?? ''}-${entry.to ?? ''}`}>
                  <td className="py-2.5 pr-4 whitespace-nowrap text-ink-2">
                    {format.dateTime(new Date(entry.at), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </td>
                  <td className="py-2.5 pr-4 text-ink">
                    {chargeLabel(entry, t)}
                    {entry.surcharge ? <span className="block text-xs text-ink-3">{t('extra', { base: entry.base, surcharge: entry.surcharge })}</span> : null}
                    {entry.fromPackage > 0 ? <span className="block text-xs text-ink-3">{t('fromPackage', { count: entry.fromPackage })}</span> : null}
                    {entry.uncharged ? <span className="block text-xs text-ink-3">{t('uncharged', { count: entry.uncharged })}</span> : null}
                  </td>
                  <td className="py-2.5 text-right font-medium text-ink">{format.number(entry.credits)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
