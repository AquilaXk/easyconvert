import { useTranslations } from 'next-intl';
import CodeBlock from './CodeBlock';
import { DOC, richText } from './doc-text';

const REQUEST_SAMPLE = `{
  "tasks": {
    "source_doc": {
      "op": "import/upload",
      "uploadId": "tus_1700000000_abcdef"
    },
    "converted_pdf": {
      "op": "convert",
      "input": "source_doc",
      "targetFormat": "pdf"
    },
    "watermarked": {
      "op": "pdf/watermark",
      "input": "converted_pdf",
      "options": {
        "text": "CONFIDENTIAL",
        "opacity": 0.3
      }
    },
    "s3_out": {
      "op": "export/s3",
      "input": "watermarked",
      "targetKey": "exports/document-final.pdf"
    }
  }
}`;

const RESPONSE_SAMPLE = `{
  "id": "job_1700000000_1234",
  "status": "completed",
  "tasks": {
    "source_doc": { "status": "completed", "progress": 100 },
    "converted_pdf": { "status": "completed", "progress": 100, "outputArtifactKey": "artifacts/conv.pdf" },
    "watermarked": { "status": "completed", "progress": 100, "outputArtifactKey": "artifacts/wm.pdf" },
    "s3_out": { "status": "completed", "progress": 100 }
  }
}`;

const REFUSALS = [
  { code: 'task-input-unknown', key: 'unknownInput' },
  { code: 'task-graph-cycle', key: 'cycle' },
  { code: 'task-name-invalid', key: 'invalidName' },
  { code: 'task-count-exceeded', key: 'countExceeded' },
  { code: 'graph-without-conversion', key: 'withoutConversion' },
] as const;

export default function NamedTasksSection() {
  const t = useTranslations('apiDocs.namedTasks');
  const tOp = useTranslations('apiDocs.operation');
  return (
    <section aria-labelledby="named-tasks" className="border-t border-rule mt-12">
      <h2 id="named-tasks" className={DOC.h2}>
        {t('heading')}
      </h2>
      <p className={DOC.p}>{t('lead')}</p>

      <h3 className={DOC.operationH3}>{t('requestTitle')}</h3>
      <p className={DOC.p}>{t.rich('requestLead', richText)}</p>
      <CodeBlock code={REQUEST_SAMPLE} copyLabel={tOp('copy')} copiedLabel={tOp('copied')} />

      <h3 className={DOC.operationH3}>{t('responseTitle')}</h3>
      <p className={DOC.p}>{t.rich('responseLead', richText)}</p>
      <CodeBlock code={RESPONSE_SAMPLE} copyLabel={tOp('copy')} copiedLabel={tOp('copied')} />

      <h3 className={DOC.operationH3}>{t('refusalsTitle')}</h3>
      <p className={DOC.p}>{t('refusalsLead')}</p>
      <ul className="my-4 divide-y divide-rule border border-rule rounded-xs bg-surface text-sm">
        {REFUSALS.map((item) => (
          <li key={item.code} className="p-3">
            <code className="font-mono text-xs font-semibold text-danger">{item.code}</code>
            <p className="text-xs text-ink-3 mt-0.5">{t(`refusals.${item.key}`)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
