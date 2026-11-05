import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import type { DocField } from './api-reference';
import { DOC } from './doc-text';
import { renderInlineCode } from './openapi-types';

const CHIP = 'rounded-xs bg-sunken text-ink-2 px-1.5 py-0.5';

/** Properties, parameters or headers, one row each: name, where it goes, type, required, description, child properties. */
export default function FieldList({ fields }: Readonly<{ fields: readonly DocField[] }>) {
  const t = useTranslations('apiDocs.operation');
  return (
    <div className="my-5 divide-y divide-rule">
      {fields.map((field) => (
        <div key={`${field.location ?? 'body'}:${field.name}`} className="py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-sm">
            <span className="font-semibold text-accent-ink break-all">{field.name}</span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs">
              {field.location && <span className={CHIP}>{t(`in.${field.location}`)}</span>}
              <span className={CHIP}>{field.type}</span>
              {field.required && <span className="rounded-xs bg-danger-soft text-danger px-1.5 py-0.5">{t('required')}</span>}
            </span>
          </div>
          {field.description && <p className="mt-3 text-sm text-ink">{renderInlineCode(field.description, DOC.smallCode)}</p>}
          {field.children.length > 0 && (
            <details className="mt-3 rounded-sm border border-rule p-3">
              <summary className="inline-flex items-center gap-1.5 text-sm text-ink-3 hover:text-ink cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                <ChevronDown className="size-4 transition-transform [details[open]>summary>&]:rotate-180" aria-hidden="true" />
                {t('childProperties')}
              </summary>
              <FieldList fields={field.children} />
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
