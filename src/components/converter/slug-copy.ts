import type { Messages, useTranslations } from 'next-intl';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '@/lib/registry';
import { otherFormats } from '@/lib/format-aliases';
import type { FormatCategory } from '@/lib/types';
import type { AppLocale } from '@/i18n/routing';
import type { ParsedSlug, SlugName } from '@/lib/slug-parser';
import {
  computeVisibleSections,
  resolveAudioCapabilities,
  type VisibleOptionsSections,
} from '../workbench/options/options-capabilities';

export type SlugCopyTranslator = ReturnType<typeof useTranslations<'slugPages'>>;

export interface LocalizedSlugCopy {
  title: string;
  description: string;
}

type NameKey = `names.${keyof Messages['slugPages']['names']}`;
type OptionSubject = keyof Messages['slugPages']['subjects'];

/** How many other targets an intro names at most, and how many option subjects. */
const RELATED_FORMAT_COUNT = 5;
const OPTION_SUBJECT_COUNT = 3;
/** The source categories whose pair pages name what the options set; other pair pages have no such sentence. */
const OPTION_INTRO_CATEGORIES: ReadonlySet<FormatCategory> = new Set<FormatCategory>(['image', 'video', 'audio']);
/** The longest intro, as the meta description it also is; the list of other targets gets shorter until the intro fits. */
const INTRO_MAX_LENGTH = 160;

/** What each control of the options dialog sets, in the order the dialog shows them, and when the dialog renders it. */
const OPTION_SUBJECTS: ReadonlyArray<[OptionSubject, (sections: VisibleOptionsSections) => boolean]> = [
  ['imageSize', (s) => s.showImage],
  ['quality', (s) => s.showImage],
  ['metadata', (s) => s.showImage],
  ['pages', (s) => s.canSelectPages],
  ['ocr', (s) => s.canConfigureOcr],
  ['password', (s) => s.passwordMode !== null],
  ['videoCodec', (s) => s.showVideo && s.showVideoCodec],
  ['frameRate', (s) => s.showVideo],
  ['resolution', (s) => s.showVideo],
  ['bitrate', (s) => s.showAudio && resolveAudioCapabilities(s.tgt).canConfigureBitrate],
  ['sampleRate', (s) => s.showAudio && resolveAudioCapabilities(s.tgt).allowedSampleRates.length > 0],
  ['channels', (s) => s.showAudio && resolveAudioCapabilities(s.tgt).allowedChannels.length > 0],
  ['compression', (s) => s.showArchive],
];

/** The word of a title (Video, Word, Spreadsheet) in the page's language; a format reads as its id in capitals. */
function nameOf(t: SlugCopyTranslator, name: SlugName): string {
  const key = `names.${name.display}` as NameKey;
  return t.has(key) ? t(key) : name.display;
}

/** The files a name stands for: "videos" for a category, "PNG files" for a format. */
function filesOf(t: SlugCopyTranslator, name: SlugName): string {
  return name.kind === 'category' ? t(`files.category.${name.id}`) : t('files.format', { name: name.display });
}

/** What a format page converts: "videos" for a category, "TTF fonts" for a registered format, "XYZ files" otherwise. */
function formatPageFiles(t: SlugCopyTranslator, name: SlugName, source: string): string {
  const category = FORMAT_REGISTRY[source]?.category;
  if (name.kind === 'category' || !category) return filesOf(t, name);
  return t(`files.kind.${category}`, { name: name.display });
}

/**
 * How each language lists names: "PNG, JPG, and GIF" in English, "PNG, JPG, GIF" in Korean, whose sentences end the list
 * with 등 or 형식으로 where the list format of the language would join the last name with the written 및. A sentence of one
 * option subject reads without 등 ("구분 기호 옵션을 정할 수 있어요.", "Options include the delimiter.").
 */
const LIST_OF: Readonly<Record<AppLocale, (items: readonly string[]) => string>> = {
  en: (items) => new Intl.ListFormat('en', { type: 'conjunction' }).format(items),
  ko: (items) => items.join(', '),
};

/** Formats the registry converts `source` to, each named once by its own name, other than `source` and `target`. */
function relatedTargets(source: string, target: string): string[] {
  const ids = getAvailableTargetFormats(source).map(({ id }) => id);
  return otherFormats(ids, [source, target])
    .slice(0, RELATED_FORMAT_COUNT)
    .map((id) => id.toUpperCase());
}

/** What the options dialog lets a person set when converting `source` to `target`, as the dialog renders it. */
function optionSubjects(source: string, target: string): OptionSubject[] {
  const sections = computeVisibleSections(source, target);
  return OPTION_SUBJECTS.filter(([, renders]) => renders(sections))
    .map(([subject]) => subject)
    .slice(0, OPTION_SUBJECT_COUNT);
}

/**
 * An intro of a lead, a sentence naming other targets and an optional last sentence. It names as many of `related` as fit
 * in the longest intro, at least one, and leaves the related sentence out when there is nothing to name.
 */
function introOf(lead: string, related: readonly string[], relatedSentence: (formats: string[]) => string, last: string[]): string {
  for (let count = related.length; count > 0; count--) {
    const intro = [lead, relatedSentence(related.slice(0, count)), ...last].join(' ');
    if (intro.length <= INTRO_MAX_LENGTH || count === 1) return intro;
  }
  return [lead, ...last].join(' ');
}

/**
 * The title and description of a slug page in the page's language. A converter page says what it converts and which other
 * formats the registry converts its source to; an image, video or audio pair page also names what the options of that pair
 * set, since a format page's options depend on the target. It claims nothing about speed or quality.
 */
export function localizeSlugCopy(t: SlugCopyTranslator, parsed: ParsedSlug, locale: AppLocale): LocalizedSlugCopy {
  const { copy, sourceFormat: source, targetFormat: target } = parsed;
  switch (copy.kind) {
    case 'info':
      return { title: t(`info.${copy.page}.title`), description: t(`info.${copy.page}.description`) };
    case 'ocr':
      return { title: t('ocr.title'), description: t('ocr.description') };
    case 'unitPair':
      return {
        title: t('unitPair.title', { src: copy.src.toUpperCase(), tgt: copy.tgt.toUpperCase() }),
        description: t('unitPair.description', {
          src: t(`units.${copy.src as 'lbs'}`),
          tgt: t(`units.${copy.tgt as 'lbs'}`),
        }),
      };
    case 'pair': {
      const names = { src: filesOf(t, copy.src), tgt: nameOf(t, copy.tgt), tgtFiles: filesOf(t, copy.tgt), tgtKind: copy.tgt.kind };
      const extractsAudio = FORMAT_REGISTRY[source]?.category === 'video' && FORMAT_REGISTRY[target]?.category === 'audio';
      const sourceCategory = FORMAT_REGISTRY[source]?.category;
      const subjects = sourceCategory && OPTION_INTRO_CATEGORIES.has(sourceCategory)
        ? optionSubjects(source, target).map((subject) => t(`subjects.${subject}`))
        : [];
      const description = introOf(
        t(extractsAudio ? 'pair.lead.extractAudio' : 'pair.lead.convert', names),
        relatedTargets(source, target),
        (formats) => t('related.pair', { formats: LIST_OF[locale](formats) }),
        subjects.length > 0 ? [t('options', { subjects: LIST_OF[locale](subjects), count: subjects.length })] : []
      );
      return { title: t('pair.title', { src: nameOf(t, copy.src), tgt: names.tgt }), description };
    }
    case 'format': {
      const description = introOf(
        t('format.lead', { files: formatPageFiles(t, copy.name, source) }),
        relatedTargets(source, source),
        (formats) => t('related.format', { formats: LIST_OF[locale](formats) }),
        []
      );
      return { title: t('format.title', { name: nameOf(t, copy.name) }), description };
    }
    case 'merge':
      return { title: t('merge.title', { format: copy.format.toUpperCase() }), description: t('merge.description', { format: copy.format.toUpperCase() }) };
    case 'compress':
      return { title: t('compress.title', { format: copy.format.toUpperCase() }), description: t('compress.description', { format: copy.format.toUpperCase() }) };
    case 'saveWebsiteAsPdf':
      return { title: t('saveWebsiteAsPdf.title'), description: t('saveWebsiteAsPdf.description') };
    case 'websiteScreenshot':
      return {
        title: t('websiteScreenshot.title', { format: copy.format.toUpperCase() }),
        description: t('websiteScreenshot.description', { format: copy.format.toUpperCase() }),
      };
    case 'generic':
      return { title: t('generic.title', { name: copy.name }), description: t('generic.description', { name: copy.name }) };
  }
}
