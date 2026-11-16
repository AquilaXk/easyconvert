import type { ComponentProps } from 'react';
import type { Link } from '@/i18n/navigation';
import type { AppLocale } from '@/i18n/routing';
import { REFUND_POLICY_SECTION_ID } from '@/lib/legal/documents';

type Href = ComponentProps<typeof Link>['href'];

/** A link of the site chrome: its label is `siteLinks.<key>` in the messages. */
export interface SiteLink {
  key: string;
  href: Href;
}

export interface ToolGroup {
  key: 'converters' | 'pdfTools' | 'archives' | 'compressImages';
  links: readonly SiteLink[];
}

export const TOOL_GROUPS = [
  {
    key: 'converters',
    links: [
      { key: 'pdfConverter', href: '/pdf-converter' },
      { key: 'imageConverter', href: '/image-converter' },
      { key: 'videoConverter', href: '/video-converter' },
      { key: 'audioConverter', href: '/audio-converter' },
      { key: 'archiveConverter', href: '/archive-converter' },
      { key: 'spreadsheetConverter', href: '/spreadsheet-converter' },
    ],
  },
  {
    key: 'pdfTools',
    links: [
      { key: 'convertToPdfA', href: '/pdfa-converter' },
      { key: 'compressPdf', href: '/compress-pdf' },
      { key: 'mergePdf', href: '/merge-pdf' },
      { key: 'splitPdf', href: '/split-pdf' },
      { key: 'rotatePdf', href: '/rotate-pdf' },
      { key: 'extractPdfPages', href: '/extract-pdf-pages' },
      { key: 'deletePdfPages', href: '/delete-pdf-pages' },
      { key: 'protectPdf', href: '/protect-pdf' },
      { key: 'unlockPdf', href: '/unlock-pdf' },
      { key: 'watermarkPdf', href: '/watermark-pdf' },
      { key: 'pdfOcr', href: '/pdf-ocr' },
    ],
  },
  {
    key: 'archives',
    links: [
      { key: 'archiveCreate', href: '/create-zip-archive' },
      { key: 'archiveExtract', href: '/extract-zip-archive' },
    ],
  },
  {
    key: 'compressImages',
    links: [
      { key: 'compressPng', href: '/compress-png' },
      { key: 'compressJpg', href: '/compress-jpg' },
    ],
  },
] as const satisfies readonly ToolGroup[];

export const TOOL_ROUTES = [
  ...TOOL_GROUPS[0].links,
  ...TOOL_GROUPS[1].links,
  ...TOOL_GROUPS[2].links,
  ...TOOL_GROUPS[3].links,
] as const satisfies readonly SiteLink[];

export const PRIMARY_LINKS = [
  { key: 'formats', href: { pathname: '/', hash: 'format-catalog' } },
  { key: 'apiDocs', href: '/api-docs' },
  { key: 'pricing', href: '/pricing' },
  { key: 'dashboard', href: '/dashboard' },
] as const satisfies readonly SiteLink[];

/** The primary links a visitor can use: the dashboard is for a signed-in person only. */
export function primaryLinksFor(signedIn: boolean): Array<(typeof PRIMARY_LINKS)[number]> {
  return PRIMARY_LINKS.filter((item) => signedIn || item.key !== 'dashboard');
}

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
      { key: 'refunds', href: '/terms' },
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

/** Where a footer link goes in `locale`: the refund policy is a section of the terms, found by the anchor its heading has in that language. */
export function footerHrefOf(link: SiteLink, locale: AppLocale): Href {
  return link.key === 'refunds' ? { pathname: '/terms', hash: REFUND_POLICY_SECTION_ID[locale] } : link.href;
}
