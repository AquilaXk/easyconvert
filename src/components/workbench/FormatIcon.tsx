import React from 'react';
import {
  Archive, BookOpen, Compass, Database, FileImage, FileText, FileType, Layers, Music, Presentation, Type, Video, type LucideIcon,
} from 'lucide-react';
import type { FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

/** The glyph of each format category, the one map every format icon of the interface reads. */
const CATEGORY_ICONS: Readonly<Record<FormatCategory, LucideIcon>> = {
  audio: Music,
  video: Video,
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

/** The formats that stand out from their category: PDF is a document too, but it is the format most pairs end in, so its tile must not read like the word processor next to it; a tile for any format shows the stack of them all. */
const FORMAT_ICONS: Readonly<Record<string, LucideIcon>> = { pdf: FileType, any: Layers };

/** The glyph of a format: its own where it has one, else that of its category; the file-type icon of a file row, and a format tile. */
export function FormatIcon({ format, className }: Readonly<{ format: string; className: string }>) {
  const id = format.toLowerCase();
  const Icon = Object.hasOwn(FORMAT_ICONS, id) ? FORMAT_ICONS[id] : categoryIcon(FORMAT_REGISTRY[id]?.category ?? 'document');
  return <Icon aria-hidden="true" className={className} />;
}
