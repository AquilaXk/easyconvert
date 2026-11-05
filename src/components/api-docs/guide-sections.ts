import type { TocItem } from './TableOfContents';

export interface GuideSection {
  readonly id: string;
  readonly children?: readonly string[];
}

export const INTRODUCTION_SECTIONS = [
  { id: 'base-url' },
  { id: 'authentication', children: ['api-keys', 'scopes'] },
  { id: 'errors' },
  { id: 'limits', children: ['daily-allowance', 'request-rate', 'concurrent-conversions', 'file-size'] },
] as const satisfies readonly GuideSection[];

export const QUICKSTART_SECTIONS = [
  { id: 'create-a-key' },
  { id: 'convert-a-file' },
  { id: 'convert-a-large-file' },
  { id: 'download-the-result' },
] as const satisfies readonly GuideSection[];

export function guideToc(sections: readonly GuideSection[], heading: (id: string) => string): TocItem[] {
  return sections.map((section) => ({
    id: section.id,
    label: heading(section.id),
    children: section.children?.map((id) => ({ id, label: heading(id) })),
  }));
}
