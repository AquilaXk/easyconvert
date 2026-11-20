import { Fragment } from 'react';
import { useTranslations } from 'next-intl';
import { CODE_AREAS, PROBLEM_TYPE_STATUSES, codeRows, type CodeArea } from '@/lib/error-inventory';
import { formatBytesForDisplay } from '@/lib/format-bytes';
import { URL_IMPORT_MAX_BYTES } from '@/lib/plan-limits';
import { DOC, richText } from './doc-text';

/** Codes whose interface sentence carries a number that depends on the request: the page words them for a reader of the API instead. */
const DOCUMENTED_MEANINGS: ReadonlySet<string> = new Set(['login_locked', 'mail_rate_limited', 'file_too_large']);

const ROWS = codeRows();

/** A name that may break after each `_` or `-`, so a narrow screen wraps a long name instead of pushing the status and the sentence out of view. */
function Name({ value }: Readonly<{ value: string }>) {
  return (
    <code className={DOC.smallCode}>
      {value.split(/(?<=[_-])/).map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span className="hidden max-sm:inline">
              <wbr />
            </span>
          )}
          {part}
        </Fragment>
      ))}
    </code>
  );
}

function StatusCell({ statuses }: Readonly<{ statuses: readonly number[] }>) {
  return <td className={`${DOC.td} font-mono sm:whitespace-nowrap`}>{statuses.join(', ')}</td>;
}

/** The problem types and the refusal codes of the API with their statuses and sentences, one anchor each; all of it from src/lib/error-inventory.ts. */
export default function ErrorsReference() {
  const t = useTranslations('apiDocs');
  const e = useTranslations('errors');
  const values = { ...richText, limit: formatBytesForDisplay(URL_IMPORT_MAX_BYTES) };
  const heading = (id: string) => t(`errors.headings.${id}` as 'errors.headings.problem-types');
  const meaning = (area: CodeArea, code: string) =>
    DOCUMENTED_MEANINGS.has(code) ? t.rich(`errors.meanings.${code}` as 'errors.meanings.login_locked', values) : e(`${area}.${code}` as 'conversion.timeout');

  return (
    <>
      <p className={DOC.p}>{t.rich('errors.intro', values)}</p>

      <h2 id="problem-types" className={DOC.h2}>{heading('problem-types')}</h2>
      <p className={DOC.p}>{t('errors.problemTypesLead')}</p>
      <div className={DOC.tableWrap}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th scope="col" className={DOC.th}>{t('errors.typeColumn')}</th>
              <th scope="col" className={`${DOC.th} w-24`}>{t('operation.status')}</th>
              <th scope="col" className={DOC.th}>{t('operation.meaning')}</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(PROBLEM_TYPE_STATUSES).map(([name, status]) => (
              <tr key={name} id={name} className="[&:last-child>td]:border-b-0">
                <td className={`${DOC.td} sm:whitespace-nowrap`}>
                  <Name value={name} />
                </td>
                <StatusCell statuses={[status]} />
                <td className={DOC.td}>{e(`problems.${name}` as 'problems.bad-request')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 id="refusal-codes" className={DOC.h2}>{heading('refusal-codes')}</h2>
      <p className={DOC.p}>{t('errors.codesLead')}</p>
      {CODE_AREAS.map((area) => (
        <section key={area}>
          <h3 id={`codes-${area}`} className={DOC.h3}>{heading(`codes-${area}`)}</h3>
          <p className={DOC.p}>{t.rich(`errors.areas.${area}`, values)}</p>
          <div className={DOC.tableWrap}>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={DOC.th}>{t('errors.codeColumn')}</th>
                  <th scope="col" className={`${DOC.th} w-24`}>{t('operation.status')}</th>
                  <th scope="col" className={DOC.th}>{t('operation.meaning')}</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.filter((row) => row.area === area).map((row) => (
                  <tr key={row.code} id={row.anchored ? row.code : undefined} className="[&:last-child>td]:border-b-0">
                    <td className={`${DOC.td} sm:whitespace-nowrap`}>
                      <Name value={row.code} />
                    </td>
                    <StatusCell statuses={row.statuses} />
                    <td className={DOC.td}>{meaning(area, row.code)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
