import type { FormatCategory, FormatDefinition } from './types';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from './registry';

export interface CategoryRegistryStat {
  id: FormatCategory;
  label: string;
  count: number;
  formats: FormatDefinition[];
}

export interface RegistryStats {
  formatCount: number;
  categoryCount: number;
  pairCount: number;
  categories: CategoryRegistryStat[];
}

export const CATEGORY_ORDER: readonly FormatCategory[] = [
  'image',
  'document',
  'archive',
  'video',
  'audio',
  'ebook',
  'spreadsheet',
  'presentation',
  'data',
  'vector',
  'font',
  'cad',
];

export const CATEGORY_LABELS: Record<FormatCategory, string> = {
  image: 'Images',
  document: 'Documents',
  archive: 'Archives',
  video: 'Video',
  audio: 'Audio',
  ebook: 'Ebooks',
  spreadsheet: 'Spreadsheets',
  presentation: 'Presentations',
  data: 'Data & Tables',
  vector: 'Vector',
  font: 'Fonts',
  cad: 'CAD & 3D',
};

function computeRegistryStats(): RegistryStats {
  const allFormats = Object.values(FORMAT_REGISTRY);
  const byCategory = new Map<FormatCategory, FormatDefinition[]>();

  for (const cat of CATEGORY_ORDER) {
    byCategory.set(cat, []);
  }

  let pairCount = 0;
  for (const format of allFormats) {
    const list = byCategory.get(format.category);
    if (list) {
      list.push(format);
    } else {
      byCategory.set(format.category, [format]);
    }
    pairCount += getAvailableTargetFormats(format.id).length;
  }

  const categories: CategoryRegistryStat[] = CATEGORY_ORDER.map((id) => {
    const formats = [...(byCategory.get(id) ?? [])].sort((a, b) =>
      a.extension.localeCompare(b.extension)
    );
    return {
      id,
      label: CATEGORY_LABELS[id],
      count: formats.length,
      formats,
    };
  });

  return {
    formatCount: allFormats.length,
    categoryCount: categories.filter((c) => c.count > 0).length,
    pairCount,
    categories,
  };
}

export const REGISTRY_STATS: RegistryStats = computeRegistryStats();
