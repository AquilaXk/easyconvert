import { useTranslations } from 'next-intl';
import { ALL_API_KEY_SCOPES } from '@/lib/api-keys/types';
import { SYNC_CONVERSION_MAX_BYTES } from '@/lib/api/file-size-limit';
import { formatBytes } from '@/lib/format-bytes';
import {
  API_KEY_BURST_LIMITS,
  DEFAULT_FREE_CONCURRENCY,
  FREE_DAILY_CONVERSIONS,
  PLAN_MAX_FILE_BYTES,
  SINGLE_REQUEST_FILE_MAX_BYTES,
} from '@/lib/plan-limits';
import { problemDetailsFields } from './api-reference';
import CodeBlock from './CodeBlock';
import { DOC, richText } from './doc-text';
import FieldList from './FieldList';
import { authenticationSample } from './guide-samples';

const ERROR_STATUSES = ['400', '401', '403', '404', '409', '413', '415', '422', '429', '500', '503', '504'] as const;

export default function IntroductionGuide({ origin }: Readonly<{ origin: string }>) {
  const t = useTranslations('apiDocs');
  const heading = (id: string) => t(`intro.headings.${id}` as 'intro.headings.base-url');
  const errorFields = problemDetailsFields().map((field) => ({
    ...field,
    description: t(`intro.problemFields.${field.name}` as 'intro.problemFields.type'),
  }));
  const copy = { copyLabel: t('operation.copy'), copiedLabel: t('operation.copied') };
  const values = {
    ...richText,
    origin,
    daily: FREE_DAILY_CONVERSIONS,
    burst: API_KEY_BURST_LIMITS.free.capacity,
    perSecond: API_KEY_BURST_LIMITS.free.refillRate,
    concurrent: DEFAULT_FREE_CONCURRENCY,
    requestMax: formatBytes(SINGLE_REQUEST_FILE_MAX_BYTES),
    fileMax: formatBytes(PLAN_MAX_FILE_BYTES.free),
    syncMax: formatBytes(SYNC_CONVERSION_MAX_BYTES),
  };
  const p = (key: Parameters<typeof t.rich>[0]) => <p className={DOC.p}>{t.rich(key, values)}</p>;

  return (
    <>
      {p('intro.lead1')}
      {p('intro.lead2')}
      {p('intro.lead3')}

      <h2 id="base-url" className={DOC.h2}>{heading('base-url')}</h2>
      {p('intro.baseUrl')}

      <h2 id="authentication" className={DOC.h2}>{heading('authentication')}</h2>
      {p('intro.authentication')}
      <h3 id="api-keys" className={DOC.h3}>{heading('api-keys')}</h3>
      {p('intro.apiKeys1')}
      {p('intro.apiKeys2')}
      <CodeBlock code={authenticationSample(origin)} {...copy} />
      {p('intro.apiKeys3')}
      <h3 id="scopes" className={DOC.h3}>{heading('scopes')}</h3>
      {p('intro.scopes')}
      <div className={DOC.tableWrap}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={DOC.th}>{t('intro.scopeColumn')}</th>
              <th scope="col" className={DOC.th}>{t('intro.allowsColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {ALL_API_KEY_SCOPES.map((scope) => (
              <tr key={scope} className="[&:last-child>td]:border-b-0">
                <td className={`${DOC.td} whitespace-nowrap`}>
                  <code className={DOC.smallCode}>{scope}</code>
                </td>
                <td className={DOC.td}>{t(`intro.scopeAllows.${scope}` as 'intro.scopeAllows.convert:read')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="errors" className={DOC.h2}>{heading('errors')}</h2>
      {p('intro.errors1')}
      <FieldList fields={errorFields} />
      {p('intro.errors2')}
      <div className={DOC.tableWrap}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={`${DOC.th} w-24`}>{t('operation.status')}</th>
              <th scope="col" className={DOC.th}>{t('operation.meaning')}</th>
            </tr>
          </thead>
          <tbody>
            {ERROR_STATUSES.map((status) => (
              <tr key={status} className="[&:last-child>td]:border-b-0">
                <td className={`${DOC.td} font-mono`}>{status}</td>
                <td className={DOC.td}>{t.rich(`intro.statuses.${status}`, values)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="limits" className={DOC.h2}>{heading('limits')}</h2>
      {p('intro.limits')}
      <h3 id="daily-allowance" className={DOC.h3}>{heading('daily-allowance')}</h3>
      {p('intro.dailyAllowance1')}
      {p('intro.dailyAllowance2')}
      <h3 id="request-rate" className={DOC.h3}>{heading('request-rate')}</h3>
      {p('intro.requestRate')}
      <h3 id="concurrent-conversions" className={DOC.h3}>{heading('concurrent-conversions')}</h3>
      {p('intro.concurrentConversions')}
      <h3 id="file-size" className={DOC.h3}>{heading('file-size')}</h3>
      {p('intro.fileSize1')}
      {p('intro.fileSize2')}
    </>
  );
}
