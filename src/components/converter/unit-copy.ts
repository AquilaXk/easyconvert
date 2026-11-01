import { useTranslations } from 'next-intl';
import type { UnitCategory, UnitDefinition } from '@/lib/unit-catalog';
import { unitNameKey } from '@/i18n/message-keys';

/** The names of the unit catalog in the page's language (`unitCategories`, `unitNames`). */
export function useUnitCopy() {
  const tCategory = useTranslations('unitCategories');
  const tUnit = useTranslations('unitNames');
  return {
    categoryName: (category: UnitCategory) => tCategory(category.id),
    unitName: (category: UnitCategory, unit: UnitDefinition) => tUnit(unitNameKey(category.id, unit.id)),
  };
}
