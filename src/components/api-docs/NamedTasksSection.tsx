import React from 'react';
import { useTranslations } from 'next-intl';

export default function NamedTasksSection() {
  const t = useTranslations('apiDocs.namedTasks');
  return (
    <section id="named-tasks" aria-labelledby="named-tasks-heading" className="mt-12 pt-10 border-t border-rule space-y-6">
      <div>
        <h2 id="named-tasks-heading" className="text-2xl font-bold text-ink">
          {t('heading')}
        </h2>
        <p className="mt-2 text-base text-ink-3">
          {t('lead')}
        </p>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-ink">{t('requestTitle')}</h3>
        <p className="text-sm text-ink-2">
          The <code className="text-accent-ink font-mono font-semibold">tasks</code> dictionary defines named nodes where each node declares an operation and its input dependencies.
        </p>
        <div className="p-4 rounded-xs border border-rule bg-surface font-mono text-xs overflow-x-auto text-ink">
          <pre>{`{
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
}`}</pre>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-ink">{t('responseTitle')}</h3>
        <p className="text-sm text-ink-2">
          Polling <code className="text-accent-ink font-mono font-semibold">GET /api/v1/jobs/{'{id}'}</code> returns execution progress and artifact keys for each named task.
        </p>
        <div className="p-4 rounded-xs border border-rule bg-surface font-mono text-xs overflow-x-auto text-ink">
          <pre>{`{
  "id": "job_1700000000_1234",
  "status": "completed",
  "tasks": {
    "source_doc": { "status": "completed", "progress": 100 },
    "converted_pdf": { "status": "completed", "progress": 100, "outputArtifactKey": "artifacts/conv.pdf" },
    "watermarked": { "status": "completed", "progress": 100, "outputArtifactKey": "artifacts/wm.pdf" },
    "s3_out": { "status": "completed", "progress": 100 }
  }
}`}</pre>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-lg font-semibold text-ink">{t('refusalsTitle')}</h3>
        <p className="text-sm text-ink-2">
          Validation errors return RFC 9457 Problem Details with status 422:
        </p>
        <ul className="divide-y divide-rule border border-rule rounded-xs bg-surface text-sm">
          <li className="p-3">
            <span className="font-mono text-xs font-semibold text-danger">task-input-unknown</span>
            <p className="text-xs text-ink-3 mt-0.5">Referenced task input does not exist in the tasks dictionary.</p>
          </li>
          <li className="p-3">
            <span className="font-mono text-xs font-semibold text-danger">task-graph-cycle</span>
            <p className="text-xs text-ink-3 mt-0.5">Circular dependency detected among tasks.</p>
          </li>
          <li className="p-3">
            <span className="font-mono text-xs font-semibold text-danger">task-name-invalid</span>
            <p className="text-xs text-ink-3 mt-0.5">Task key contains invalid characters (must match alphanumeric, hyphen, underscore).</p>
          </li>
          <li className="p-3">
            <span className="font-mono text-xs font-semibold text-danger">task-count-exceeded</span>
            <p className="text-xs text-ink-3 mt-0.5">Task count exceeds tier limits.</p>
          </li>
          <li className="p-3">
            <span className="font-mono text-xs font-semibold text-danger">graph-without-conversion</span>
            <p className="text-xs text-ink-3 mt-0.5">Graph must contain at least one processing or conversion node.</p>
          </li>
        </ul>
      </div>
    </section>
  );
}
