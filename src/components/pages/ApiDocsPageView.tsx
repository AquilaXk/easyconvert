import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { docOperation } from '@/components/api-docs/api-reference';
import { guideToc, INTRODUCTION_SECTIONS, QUICKSTART_SECTIONS } from '@/components/api-docs/guide-sections';
import IntroductionGuide from '@/components/api-docs/IntroductionGuide';
import OperationSection from '@/components/api-docs/OperationSection';
import QuickstartGuide from '@/components/api-docs/QuickstartGuide';
import TableOfContents, { type TocItem } from '@/components/api-docs/TableOfContents';
import TopicNav from '@/components/api-docs/TopicNav';
import { API_DOC_TOPIC_BY_SLUG, type ApiDocTopicSlug } from '@/components/api-docs/topics';
import { siteMetadataBase } from '@/i18n/metadata';

export default function ApiDocsPageView({ topic }: Readonly<{ topic: ApiDocTopicSlug }>) {
  const t = useTranslations('apiDocs');
  const entry = API_DOC_TOPIC_BY_SLUG[topic];
  const origin = siteMetadataBase()?.origin ?? '';
  const operations = entry.operations.map((ref) => docOperation(ref, origin));

  let body: ReactNode;
  let toc: TocItem[];
  if (topic === 'introduction') {
    body = <IntroductionGuide origin={origin} />;
    toc = guideToc(INTRODUCTION_SECTIONS, (id) => t(`intro.headings.${id}` as 'intro.headings.base-url'));
  } else if (topic === 'quickstart') {
    body = <QuickstartGuide origin={origin} />;
    toc = guideToc(QUICKSTART_SECTIONS, (id) => t(`quickstart.headings.${id}` as 'quickstart.headings.create-a-key'));
  } else {
    body = operations.map((operation) => <OperationSection key={operation.anchor} operation={operation} origin={origin} />);
    toc = operations.map((operation) => ({ id: operation.anchor, label: t(`operations.${operation.anchor}.title`) }));
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <div className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 lg:grid lg:grid-cols-10 lg:gap-10">
        <TopicNav current={topic} />
        <div className="lg:col-span-8 lg:grid lg:grid-cols-10 lg:gap-10">
          <div className="lg:col-span-2 lg:order-last">
            <TableOfContents title={t('toc')} items={toc} />
          </div>
          <main id="main-content" className="lg:col-span-8 min-w-0 text-ink">
            <div className="border-b border-rule py-8">
              <p className="mb-2.5 text-sm font-semibold text-accent-ink">{t(`nav.groups.${entry.group}`)}</p>
              <h1 className="text-3xl sm:text-4xl font-bold text-ink text-pretty">{t(`topics.${topic}.title`)}</h1>
              <p className="mt-4 text-lg text-ink-3 text-pretty">{t(`topics.${topic}.lead`)}</p>
            </div>
            <div className="mt-8 pb-24">{body}</div>
          </main>
        </div>
      </div>
      <Footer />
    </div>
  );
}
