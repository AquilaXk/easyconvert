import React from 'react';
import {
  Archive, BookOpen, Compass, Database, FileImage, FileText, Music, Presentation, Type, Video, type LucideIcon,
} from 'lucide-react';
import type { FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

const CATEGORY_ICONS: Partial<Record<FormatCategory, LucideIcon>> = {
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
};

/** The glyph of a format's category: the file-type icon of a file row, a format tile and a popular-conversion card. */
export function FormatIcon({ format, className }: Readonly<{ format: string; className: string }>) {
  const category = FORMAT_REGISTRY[format.toLowerCase()]?.category ?? 'document';
  const Icon = CATEGORY_ICONS[category] ?? FileText;
  return <Icon aria-hidden="true" className={className} />;
}
