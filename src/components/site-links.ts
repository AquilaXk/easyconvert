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
  { key: 'unitConverter', href: '/unit-converter' },
  { key: 'pdfOcr', href: '/pdf-ocr' },
  { key: 'compressPdf', href: '/compress-pdf' },
  { key: 'mergePdf', href: '/merge-pdf' },
  { key: 'systemStatus', href: '/status' },
] as const satisfies readonly SiteLink[];

export const PRIMARY_LINKS = [
  { key: 'formats', href: { pathname: '/', hash: 'format-catalog' } },
  { key: 'apiDocs', href: '/api-docs' },
  { key: 'dashboard', href: '/dashboard' },
] as const satisfies readonly SiteLink[];

export interface DirectoryCategory {
  key: string;
  links: readonly SiteLink[];
}

/** The footer directory: each category heading is `footer.categories.<key>`. */
export const DIRECTORY_CATEGORIES = [
  {
    key: 'video',
    links: [
      { key: 'mp4Converter', href: '/mp4-converter' },
      { key: 'videoToGif', href: '/video-to-gif' },
      { key: 'movToMp4', href: '/mov-to-mp4' },
      { key: 'videoConverter', href: '/video-converter' },
    ],
  },
  {
    key: 'audio',
    links: [
      { key: 'mp3Converter', href: '/mp3-converter' },
      { key: 'mp4ToMp3', href: '/mp4-to-mp3' },
      { key: 'videoToMp3', href: '/video-to-mp3' },
      { key: 'audioConverter', href: '/audio-converter' },
    ],
  },
  {
    key: 'image',
    links: [
      { key: 'jpgToPdf', href: '/jpg-to-pdf' },
      { key: 'pdfToJpg', href: '/pdf-to-jpg' },
      { key: 'heicToJpg', href: '/heic-to-jpg' },
      { key: 'imageToPdf', href: '/image-to-pdf' },
      { key: 'imageConverter', href: '/image-converter' },
    ],
  },
  {
    key: 'documentEbook',
    links: [
      { key: 'pdfToWord', href: '/pdf-to-docx' },
      { key: 'epubToPdf', href: '/epub-to-pdf' },
      { key: 'documentConverter', href: '/document-converter' },
    ],
  },
  {
    key: 'archive',
    links: [
      { key: 'rarToZip', href: '/rar-to-zip' },
      { key: 'sevenZipToZip', href: '/7z-to-zip' },
      { key: 'compressPdf', href: '/compress-pdf' },
      { key: 'archiveConverter', href: '/archive-converter' },
    ],
  },
  {
    key: 'dataUnits',
    links: [
      { key: 'csvToJson', href: '/csv-to-json' },
      { key: 'jsonToCsv', href: '/json-to-csv' },
      { key: 'lbsToKg', href: '/lbs-to-kg' },
      { key: 'unitConverter', href: '/unit-converter' },
    ],
  },
  {
    key: 'webApps',
    links: [
      { key: 'saveWebsiteAsPdf', href: '/save-website-as-pdf' },
      { key: 'imageResizer', href: '/image-converter' },
      { key: 'websiteScreenshot', href: '/website-png-screenshot' },
      { key: 'pdfOcr', href: '/pdf-ocr' },
    ],
  },
  {
    key: 'clientEdge',
    links: [
      { key: 'mp4Remuxer', href: '/mp4-converter' },
      { key: 'losslessPng', href: '/compress-png' },
      { key: 'vectorConverter', href: '/vector-converter' },
      { key: 'securityArchitecture', href: '/security' },
    ],
  },
] as const satisfies readonly DirectoryCategory[];

export const SECONDARY_LINKS = [
  { key: 'aboutUs', href: '/about' },
  { key: 'formats', href: { pathname: '/', hash: 'format-catalog' } },
  { key: 'apiDocs', href: '/api-docs' },
  { key: 'privacy', href: '/privacy' },
  { key: 'terms', href: '/terms' },
  { key: 'security', href: '/security' },
  { key: 'accessibility', href: '/accessibility' },
  { key: 'contact', href: '/contact' },
  { key: 'status', href: '/status' },
] as const satisfies readonly SiteLink[];
