import { useTranslations } from 'next-intl';
import type { DocAccess, DocBody, DocOperation } from './api-reference';
import CodeBlock from './CodeBlock';
import { DOC, richText } from './doc-text';
import FieldList from './FieldList';
import { renderInlineCode } from './openapi-types';

/** The solid method label of the endpoint line, a colour of the palette for each method. */
const METHOD_CLASSES: Readonly<Record<string, string>> = {
  get: 'bg-success',
  post: 'bg-info',
  put: 'bg-warning',
  patch: 'bg-warning',
  delete: 'bg-danger',
  head: 'bg-ink-3',
  options: 'bg-ink-3',
};

function EndpointLine({ method, path, origin }: Readonly<{ method: string; path: string; origin: string }>) {
  return (
    <div className="flex items-center gap-2 border border-rule p-2 overflow-x-auto">
      <span className={`shrink-0 rounded-xs px-2 py-1 text-xs font-medium text-canvas ${METHOD_CLASSES[method]}`}>{method.toUpperCase()}</span>
      <code className="font-mono text-sm leading-6 text-ink-2 whitespace-nowrap">
        {origin}
        <span className="font-semibold text-ink">{path}</span>
      </code>
    </div>
  );
}

function Access({ access }: Readonly<{ access: DocAccess }>) {
  const t = useTranslations('apiDocs.operation');
  if (access.kind === 'public') return <p className={DOC.p}>{t('access.public')}</p>;
  const scopes = access.scopes.join(', ');
  const key = access.kind === 'key' ? 'key' : 'optionalKey';
  return <p className={DOC.p}>{t.rich(scopes ? `access.${key}Scoped` : `access.${key}`, { ...richText, scopes })}</p>;
}

function Bodies({ bodies }: Readonly<{ bodies: readonly DocBody[] }>) {
  const t = useTranslations('apiDocs.operation');
  return bodies.map((body) => (
    <div key={body.mediaType}>
      {bodies.length > 1 && <p className={DOC.p}>{t.rich('mediaType', { ...richText, mediaType: body.mediaType })}</p>}
      {body.fields.length > 0 ? <FieldList fields={body.fields} /> : <p className={DOC.p}>{t('binaryBody')}</p>}
    </div>
  ));
}

/** One operation of a reference page: its endpoint, who may call it, its parameters, body, answers and an example. */
export default function OperationSection({ operation, origin }: Readonly<{ operation: DocOperation; origin: string }>) {
  const t = useTranslations('apiDocs');
  const { anchor } = operation;
  return (
    <section aria-labelledby={anchor} className="border-t border-rule first:border-t-0 mt-12 first:mt-0">
      <h2 id={anchor} className={DOC.h2}>
        {t(`operations.${anchor}.title`)}
      </h2>
      <p className={DOC.p}>{t.rich(`operations.${anchor}.lead`, richText)}</p>
      <EndpointLine method={operation.method} path={operation.path} origin={origin} />

      <h3 className={DOC.operationH3}>{t('operation.authentication')}</h3>
      <Access access={operation.access} />

      {operation.parameters.length > 0 && (
        <>
          <h3 className={DOC.operationH3}>{t('operation.parameters')}</h3>
          <FieldList fields={operation.parameters} />
        </>
      )}

      {operation.requestBodies.length > 0 && (
        <>
          <h3 className={DOC.operationH3}>{t('operation.requestBody')}</h3>
          <Bodies bodies={operation.requestBodies} />
        </>
      )}

      <h3 className={DOC.operationH3}>{t('operation.response')}</h3>
      {operation.responses.map((response) => (
        <div key={response.status}>
          <p className={DOC.p}>
            <code className={DOC.code}>{response.status}</code> {response.description && renderInlineCode(response.description, DOC.code)}
          </p>
          {response.headers.length > 0 && <FieldList fields={response.headers} />}
          <Bodies bodies={response.bodies} />
        </div>
      ))}

      {operation.errors.length > 0 && (
        <>
          <h3 className={DOC.operationH3}>{t('operation.errors')}</h3>
          <div className={DOC.tableWrap}>
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={`${DOC.th} w-24`}>{t('operation.status')}</th>
                  <th scope="col" className={DOC.th}>{t('operation.meaning')}</th>
                </tr>
              </thead>
              <tbody>
                {operation.errors.map((error) => (
                  <tr key={error.status} className="[&:last-child>td]:border-b-0">
                    <td className={`${DOC.td} font-mono`}>{error.status}</td>
                    <td className={DOC.td}>{renderInlineCode(error.description, DOC.smallCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className={DOC.operationH3}>{t('operation.example')}</h3>
      <CodeBlock code={operation.curl} copyLabel={t('operation.copy')} copiedLabel={t('operation.copied')} />
    </section>
  );
}
