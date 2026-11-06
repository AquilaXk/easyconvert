import type { FormatCategory } from '@/lib/types';
import type { routing } from './routing';
import type messages from '../../messages/en.json';

declare module 'next-intl' {
  interface AppConfig {
    Locale: (typeof routing.locales)[number];
    Messages: typeof messages & {
      formatDescriptions: Record<string, string>;
      formatCategories: Record<FormatCategory, string>;
    };
  }
}
