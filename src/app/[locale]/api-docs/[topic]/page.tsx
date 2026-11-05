import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import ApiDocsPageView from '@/components/pages/ApiDocsPageView';
import { API_DOC_SUBPAGES, apiDocsHref, findApiDocTopic, type ApiDocTopic } from '@/components/api-docs/topics';
import { localeAlternates } from '@/i18n/metadata';
import PageMessages from '@/i18n/PageMessages';
import { resolvePageLocale } from '@/i18n/page';

type TopicParams = Promise<{ locale: string; topic: string }>;

/** Every topic is prerendered; any other segment under `/api-docs/` is a 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return API_DOC_SUBPAGES.map((topic) => ({ topic: topic.slug }));
}

async function topicOf(params: TopicParams): Promise<ApiDocTopic> {
  const topic = findApiDocTopic((await params).topic);
  if (!topic || topic.slug === 'introduction') notFound();
  return topic;
}

export async function generateMetadata({ params }: { params: TopicParams }): Promise<Metadata> {
  const locale = await resolvePageLocale(params);
  const topic = await topicOf(params);
  const t = await getTranslations({ locale, namespace: 'apiDocs' });
  return {
    title: t('metaTitle', { topic: t(`topics.${topic.slug}.title`) }),
    description: t(`topics.${topic.slug}.lead`),
    alternates: localeAlternates(locale, apiDocsHref(topic.slug)),
  };
}

export default async function ApiDocsTopicPage({ params }: Readonly<{ params: TopicParams }>) {
  await resolvePageLocale(params);
  const topic = await topicOf(params);
  return (
    <PageMessages page="apiDocs">
      <ApiDocsPageView topic={topic.slug} />
    </PageMessages>
  );
}
