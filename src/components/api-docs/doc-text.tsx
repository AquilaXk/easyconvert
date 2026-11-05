import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { apiDocsHref, type ApiDocTopicSlug } from './topics';

/** The text styles of the documentation, measured on the reference documentation (entry 147 of docs/policy-decisions.md). */
export const DOC = {
  p: 'my-5 leading-7 text-pretty',
  h2: 'text-2xl font-bold text-ink mt-12 mb-6',
  h3: 'text-xl font-bold text-ink mt-8 mb-3',
  operationH3: 'text-lg font-bold text-ink mt-6 mb-2',
  code: 'px-1.5 py-0.5 text-sm font-mono font-medium rounded-xs border border-rule bg-sunken text-ink',
  smallCode: 'px-1 py-px text-xs font-mono font-medium rounded-xs border border-rule bg-sunken text-ink',
  link: 'font-medium text-accent-ink border-b border-transparent hover:border-accent-ink transition-colors',
  list: 'list-disc ps-6 my-5 marker:text-rule-strong',
  listItem: 'my-1.5 ps-1.5 leading-7',
  tableWrap: 'relative my-5 overflow-x-auto rounded-xs border border-rule',
  th: 'py-3 px-4 text-left text-sm font-semibold bg-sunken border-b border-rule',
  td: 'py-3 px-4 text-sm align-top border-b border-rule',
} as const;

/** The tags the documentation's messages use: inline code, a link to another page of the docs or the dashboard, a link out. */
export const richText = {
  code: (chunks: ReactNode) => <code className={DOC.code}>{chunks}</code>,
  strong: (chunks: ReactNode) => <strong className="font-semibold text-ink">{chunks}</strong>,
  quickstart: (chunks: ReactNode) => <DocLink topic="quickstart">{chunks}</DocLink>,
  uploads: (chunks: ReactNode) => <DocLink topic="uploads">{chunks}</DocLink>,
  jobs: (chunks: ReactNode) => <DocLink topic="jobs">{chunks}</DocLink>,
  downloads: (chunks: ReactNode) => <DocLink topic="downloads">{chunks}</DocLink>,
  usage: (chunks: ReactNode) => <DocLink topic="usage">{chunks}</DocLink>,
  formats: (chunks: ReactNode) => <DocLink topic="formats">{chunks}</DocLink>,
  keys: (chunks: ReactNode) => (
    <Link href="/dashboard/api-keys" className={DOC.link}>
      {chunks}
    </Link>
  ),
  openapi: (chunks: ReactNode) => (
    <a href="/api/v1/openapi.json" className={DOC.link}>
      {chunks}
    </a>
  ),
};

function DocLink({ topic, children }: Readonly<{ topic: ApiDocTopicSlug; children: ReactNode }>) {
  return (
    <Link href={apiDocsHref(topic)} className={DOC.link}>
      {children}
    </Link>
  );
}
