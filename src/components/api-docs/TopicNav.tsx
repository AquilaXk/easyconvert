import { useTranslations } from 'next-intl';
import {
  Archive,
  ChevronDown,
  Download,
  FileType,
  Gauge,
  House,
  Languages,
  ListChecks,
  RefreshCw,
  Upload,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { API_DOC_TOPICS, apiDocsHref, type ApiDocGroup, type ApiDocTopicSlug } from './topics';

const GROUPS: readonly ApiDocGroup[] = ['gettingStarted', 'reference'];

const TOPIC_ICONS: Readonly<Record<ApiDocTopicSlug, LucideIcon>> = {
  introduction: House,
  quickstart: Zap,
  convert: RefreshCw,
  jobs: ListChecks,
  uploads: Upload,
  downloads: Download,
  formats: FileType,
  'ocr-languages': Languages,
  archives: Archive,
  usage: Gauge,
};

function TopicList({ current, tall }: Readonly<{ current: ApiDocTopicSlug; tall: boolean }>) {
  const t = useTranslations('apiDocs');
  return (
    <ul className="space-y-1.5">
      {GROUPS.map((group) => (
        <li key={group}>
          <p className="px-2.5 py-1.5 text-sm font-semibold text-ink">{t(`nav.groups.${group}`)}</p>
          <ul className="ms-5 border-s border-rule">
            {API_DOC_TOPICS.filter((topic) => topic.group === group).map((topic) => {
              const Icon = TOPIC_ICONS[topic.slug];
              const active = topic.slug === current;
              return (
                <li key={topic.slug} className={`-ms-px ps-1.5 border-s ${active ? 'border-accent-ink' : 'border-transparent'}`}>
                  <Link
                    href={apiDocsHref(topic.slug)}
                    aria-current={active ? 'page' : undefined}
                    className={`group flex items-center gap-1.5 px-2.5 ${tall ? 'min-h-[44px]' : 'py-1.5'} rounded-xs text-sm transition-colors ${
                      active ? 'text-accent-ink' : 'text-ink-3 hover:text-ink'
                    }`}
                  >
                    <Icon
                      className={`size-4 mx-0.5 shrink-0 ${active ? 'text-accent-ink' : 'text-ink-3 group-hover:text-ink'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{t(`topics.${topic.slug}.nav`)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default function TopicNav({ current }: Readonly<{ current: ApiDocTopicSlug }>) {
  const t = useTranslations('apiDocs.nav');
  return (
    <>
      <aside className="hidden lg:block lg:col-span-2 lg:sticky lg:top-[var(--header-height)] lg:max-h-[calc(100vh-var(--header-height))] overflow-y-auto py-4 -ms-2.5">
        <nav aria-label={t('label')}>
          <TopicList current={current} tall={false} />
        </nav>
      </aside>
      <details className="group/menu lg:hidden border-b border-dashed border-rule">
        <summary className="flex items-center justify-between min-h-[44px] py-2 text-sm font-semibold text-ink cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          {t('menu')}
          <ChevronDown className="size-4 text-ink-3 transition-transform group-open/menu:rotate-180" aria-hidden="true" />
        </summary>
        <nav aria-label={t('label')} className="pb-4 -ms-2.5">
          <TopicList current={current} tall />
        </nav>
      </details>
    </>
  );
}
