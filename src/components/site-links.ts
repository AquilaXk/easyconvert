import type { ComponentProps } from 'react';
import type { Link } from '@/i18n/navigation';

type Href = ComponentProps<typeof Link>['href'];

/** A link of the site chrome: its label is `siteLinks.<key>` in the messages. */
export interface SiteLink {
  key: string;
  href: Href;
}

export const TOOL_ROUTES = [
  { key: 'pdfConverter', href: '/pdf-converter' },
  { key: 'imageConverter', href: '/image-converter' },
  { key: 'videoConverter', href: '/video-converter' },
  { key: 'audioConverter', href: '/audio-converter' },
  { key: 'archiveConverter', href: '/archive-converter' },
  { key: 'spreadsheetConverter', href: '/spreadsheet-converter' },
  { key: 'pdfOcr', href: '/pdf-ocr' },
  { key: 'compressPdf', href: '/compress-pdf' },
  { key: 'mergePdf', href: '/merge-pdf' },
] as const satisfies readonly SiteLink[];

export const PRIMARY_LINKS = [
  { key: 'formats', href: { pathname: '/', hash: 'format-catalog' } },
  { key: 'apiDocs', href: '/api-docs' },
  { key: 'pricing', href: '/pricing' },
  { key: 'dashboard', href: '/dashboard' },
] as const satisfies readonly SiteLink[];

/** What the mobile menu's collapsed API group holds. */
export const API_LINKS = [
  { key: 'apiDocs', href: '/api-docs' },
  { key: 'apiKeys', href: '/dashboard/api-keys' },
] as const satisfies readonly SiteLink[];

export interface FooterColumn {
  key: string;
  links: readonly SiteLink[];
}

/** The footer's columns: each heading is `footer.columns.<key>`. */
export const FOOTER_COLUMNS = [
  {
    key: 'company',
    links: [
      { key: 'aboutUs', href: '/about' },
      { key: 'security', href: '/security' },
    ],
  },
  {
    key: 'resources',
    links: [
      { key: 'formats', href: { pathname: '/', hash: 'format-catalog' } },
      { key: 'apiDocs', href: '/api-docs' },
      { key: 'pricing', href: '/pricing' },
    ],
  },
  {
    key: 'legal',
    links: [
      { key: 'privacy', href: '/privacy' },
      { key: 'terms', href: '/terms' },
      { key: 'acceptableUse', href: '/acceptable-use' },
      { key: 'dpa', href: '/dpa' },
      { key: 'accessibility', href: '/accessibility' },
    ],
  },
  {
    key: 'contact',
    links: [{ key: 'contact', href: '/contact' }],
  },
] as const satisfies readonly FooterColumn[];
