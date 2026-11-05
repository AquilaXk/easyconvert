import type { HttpMethod } from './openapi-types';

export interface ApiDocOperationRef {
  readonly anchor: string;
  readonly method: HttpMethod;
  readonly path: string;
}

export type ApiDocGroup = 'gettingStarted' | 'reference';

interface ApiDocTopicEntry {
  readonly slug: string;
  readonly group: ApiDocGroup;
  readonly operations: readonly ApiDocOperationRef[];
}

export const API_DOC_TOPICS = [
  { slug: 'introduction', group: 'gettingStarted', operations: [] },
  { slug: 'quickstart', group: 'gettingStarted', operations: [] },
  {
    slug: 'convert',
    group: 'reference',
    operations: [{ anchor: 'convert-a-file', method: 'post', path: '/api/v1/convert' }],
  },
  {
    slug: 'jobs',
    group: 'reference',
    operations: [
      { anchor: 'create-a-job', method: 'post', path: '/api/v1/jobs' },
      { anchor: 'show-a-job', method: 'get', path: '/api/v1/jobs/{id}' },
      { anchor: 'list-jobs', method: 'get', path: '/api/v1/jobs' },
      { anchor: 'cancel-a-job', method: 'delete', path: '/api/v1/jobs/{id}' },
    ],
  },
  {
    slug: 'uploads',
    group: 'reference',
    operations: [
      { anchor: 'start-a-direct-upload', method: 'post', path: '/api/v1/uploads/direct' },
      { anchor: 'upload-a-part', method: 'put', path: '/api/v1/uploads/direct/part' },
      { anchor: 'complete-a-direct-upload', method: 'post', path: '/api/v1/uploads/direct/complete' },
      { anchor: 'abort-a-direct-upload', method: 'delete', path: '/api/v1/uploads/direct/{id}' },
      { anchor: 'create-a-resumable-upload', method: 'post', path: '/api/v1/uploads' },
      { anchor: 'append-a-chunk', method: 'patch', path: '/api/v1/uploads/{id}' },
      { anchor: 'read-the-upload-offset', method: 'head', path: '/api/v1/uploads/{id}' },
      { anchor: 'terminate-a-resumable-upload', method: 'delete', path: '/api/v1/uploads/{id}' },
      { anchor: 'discover-the-upload-capabilities', method: 'options', path: '/api/v1/uploads' },
    ],
  },
  {
    slug: 'downloads',
    group: 'reference',
    operations: [{ anchor: 'download-a-file', method: 'get', path: '/api/storage/file/{key}' }],
  },
  {
    slug: 'formats',
    group: 'reference',
    operations: [{ anchor: 'list-formats', method: 'get', path: '/api/formats' }],
  },
  {
    slug: 'ocr-languages',
    group: 'reference',
    operations: [{ anchor: 'list-ocr-languages', method: 'get', path: '/api/v1/ocr/languages' }],
  },
  {
    slug: 'archives',
    group: 'reference',
    operations: [{ anchor: 'inspect-an-archive', method: 'post', path: '/api/v1/archives/inspect' }],
  },
  {
    slug: 'usage',
    group: 'reference',
    operations: [{ anchor: 'show-the-daily-allowance', method: 'get', path: '/api/keys/usage' }],
  },
] as const satisfies readonly ApiDocTopicEntry[];

export type ApiDocTopic = (typeof API_DOC_TOPICS)[number];
export type ApiDocTopicSlug = ApiDocTopic['slug'];
export type ApiDocAnchor = ApiDocTopic['operations'][number]['anchor'];

export const API_DOC_SUBPAGES = API_DOC_TOPICS.filter((topic) => topic.slug !== 'introduction');

export function apiDocsHref(slug: ApiDocTopicSlug): string {
  return slug === 'introduction' ? '/api-docs' : `/api-docs/${slug}`;
}

export function findApiDocTopic(slug: string): ApiDocTopic | undefined {
  return API_DOC_TOPICS.find((topic) => topic.slug === slug);
}

export const API_DOC_TOPIC_BY_SLUG = Object.fromEntries(API_DOC_TOPICS.map((topic) => [topic.slug, topic])) as Readonly<
  Record<ApiDocTopicSlug, ApiDocTopic>
>;
