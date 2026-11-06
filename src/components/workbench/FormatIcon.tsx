import React from 'react';
import {
  Archive, BookOpen, Compass, Database, FileImage, FileText, Music, Presentation, Type, Video, type LucideIcon,
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
function categoryIcon(category: string): LucideIcon {
  return Object.hasOwn(CATEGORY_ICONS, category) ? CATEGORY_ICONS[category as FormatCategory] : CATEGORY_ICONS.document;
}

/** The glyph of a format's category: the file-type icon of a file row, and a format tile. */
export function FormatIcon({ format, className }: Readonly<{ format: string; className: string }>) {
  const Icon = categoryIcon(FORMAT_REGISTRY[format.toLowerCase()]?.category ?? 'document');
  return <Icon aria-hidden="true" className={className} />;
}
