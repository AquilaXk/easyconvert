import React from 'react';
import {
  Archive, BookOpen, Captions, Compass, Database, FileImage, FileText, Layers, Music, Presentation, Type, Video, type LucideIcon,
} from 'lucide-react';
import type { FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

/** The glyph of each format category: the one-colour icons of the catalogue tabs. */
const CATEGORY_ICONS: Readonly<Record<FormatCategory, LucideIcon>> = {
  audio: Music,
  video: Video,
  subtitle: Captions,
  image: FileImage,
  vector: Compass,
  cad: Compass,
  ebook: BookOpen,
  presentation: Presentation,
  spreadsheet: Database,
  data: Database,
  archive: Archive,
  font: Type,
  document: FileText,
};

/** The glyph of a category the registry names; a category it does not know reads as a document. */
export function categoryIcon(category: string): LucideIcon {
  return Object.hasOwn(CATEGORY_ICONS, category) ? CATEGORY_ICONS[category as FormatCategory] : CATEGORY_ICONS.document;
}

/**
 * The file icon of each category, from the Material file icons (material-icon-theme 5.40.0, MIT, copied into public/format-icons
 * with its LICENSE; word.svg is lightened for the dark tiles, see docs/licensing.md): one colour per kind of file, so a PDF reads apart from the Word file next to it.
 */
const CATEGORY_FILE_ICONS: Readonly<Record<FormatCategory, string>> = {
  audio: 'audio',
  video: 'video',
  subtitle: 'subtitles',
  image: 'image',
  vector: 'svg',
  cad: '3d',
  ebook: 'epub',
  presentation: 'powerpoint',
  spreadsheet: 'table',
  data: 'database',
  archive: 'zip',
  font: 'font',
  document: 'document',
};

/** Formats whose own file icon says more than their category's. */
const FORMAT_FILE_ICONS: Readonly<Record<string, string>> = {
  pdf: 'pdf', pdfa: 'pdf',
  doc: 'word', docx: 'word', docm: 'word', dot: 'word', dotx: 'word', rtf: 'word', odt: 'word', ott: 'word', fodt: 'word',
  md: 'markdown', html: 'html', htm: 'html', xhtml: 'html',
  eml: 'email', msg: 'email',
  csv: 'table', tsv: 'table', tab: 'table',
  json: 'json', jsonl: 'json', ndjson: 'json', xml: 'xml',
};

/**
 * The file icon of a format: its own where it has one, else that of its category; a file row and a format tile. A tile for any format shows the stack of them all.
 * The file shape fills 20 of the 24 units of each icon, so a box 1.2 times the wanted glyph height draws it as tall as the reference converter's (32 px on a tile, 20 px on a card or file row, 16 px in a format chip).
 */
export function FormatIcon({ format, className }: Readonly<{ format: string; className: string }>) {
  const id = format.toLowerCase();
  if (id === 'any') return <Layers aria-hidden="true" className={className} />;
  const name = Object.hasOwn(FORMAT_FILE_ICONS, id)
    ? FORMAT_FILE_ICONS[id]
    : CATEGORY_FILE_ICONS[(FORMAT_REGISTRY[id]?.category ?? 'document') as FormatCategory] ?? CATEGORY_FILE_ICONS.document;
  // eslint-disable-next-line @next/next/no-img-element -- a 24-unit vector file: the image optimiser has nothing to do for it.
  return <img src={`/format-icons/${name}.svg`} alt="" aria-hidden="true" width={24} height={24} className={className} draggable={false} />;
}
