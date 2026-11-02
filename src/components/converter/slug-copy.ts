import type { Messages, useTranslations } from 'next-intl';
import { getAvailableTargetFormats } from '@/lib/registry';
import { canonicalFormat } from '@/lib/format-aliases';
import type { ParsedSlug, SlugName } from '@/lib/slug-parser';
import { computeVisibleSections, type VisibleOptionsSections } from '../workbench/options/options-capabilities';

export type SlugCopyTranslator = ReturnType<typeof useTranslations<'slugPages'>>;

export interface LocalizedSlugCopy {
  title: string;
  description: string;
}

type NameKey = `names.${keyof Messages['slugPages']['names']}`;
type OptionSubject = keyof Messages['slugPages']['subjects'];

/** How many related formats and option subjects a description names, as the reference layout's intro does. */
const RELATED_FORMAT_COUNT = 5;
const OPTION_SUBJECT_COUNT = 3;

/** What each section of the options dialog lets a person set, in the order the dialog shows them. */
const OPTION_SUBJECTS: ReadonlyArray<[OptionSubject, (sections: VisibleOptionsSections) => boolean]> = [
  ['imageSize', (s) => s.showImage],
  ['quality', (s) => s.showImage],
  ['metadata', (s) => s.showImage],
  ['videoCodec', (s) => s.showVideo && s.showVideoCodec],
  ['frameRate', (s) => s.showVideo],
  ['resolution', (s) => s.showVideo],
  ['bitrate', (s) => s.showAudio],
  ['sampleRate', (s) => s.showAudio],
  ['channels', (s) => s.showAudio],
  ['pages', (s) => s.canSelectPages],
  ['orientation', (s) => s.canConfigureLayout],
  ['ocr', (s) => s.canConfigureOcr],
  ['password', (s) => s.passwordMode !== null],
  ['delimiter', (s) => s.canConfigureDelimiter],
  ['sheet', (s) => s.canConfigureSheetIndex],
  ['compression', (s) => s.showArchive],
];

/** A word of a title (Video, Word, Spreadsheet) in the page's language; a format name reads as the English copy names it. */
function nameOf(t: SlugCopyTranslator, name: SlugName): string {
  const key = `names.${name.display}` as NameKey;
  return t.has(key) ? t(key) : name.display;
}

/** A list in the page's language: "PNG, JPG, and GIF" in English, "PNG, JPG, GIF" in Korean. */
function listOf(locale: string, items: readonly string[]): string {
  return locale === 'en' ? new Intl.ListFormat('en', { type: 'conjunction' }).format(items) : items.join(', ');
}

/** Formats the registry converts `source` to, each named once, other than those named in `exclude` or another name of them. */
function relatedTargets(source: string, exclude: readonly string[]): string[] {
  const named = new Set(exclude.map(canonicalFormat));
  const related: string[] = [];
  for (const { id } of getAvailableTargetFormats(source)) {
    if (related.length === RELATED_FORMAT_COUNT) break;
    if (named.has(canonicalFormat(id))) continue;
    named.add(canonicalFormat(id));
    related.push(id.toUpperCase());
  }
  return related;
}

/** What the options dialog lets a person set when converting `source` to `target`. */
function optionSubjects(source: string, target: string): OptionSubject[] {
  const sections = computeVisibleSections(source, target);
  return OPTION_SUBJECTS.filter(([, shows]) => shows(sections))
    .map(([subject]) => subject)
    .slice(0, OPTION_SUBJECT_COUNT);
}

/** The first target the registry lists for `source` other than itself: the pair a format page's options are read from. */
function firstTarget(source: string): string | undefined {
  return getAvailableTargetFormats(source).find((format) => format.id !== source)?.id;
}

/** The sentence that names what the options set, or nothing when the pair has no options. */
function optionsSentence(t: SlugCopyTranslator, locale: string, source: string, target: string | undefined): string[] {
  const subjects = target ? optionSubjects(source, target) : [];
  return subjects.length === 0 ? [] : [t('options', { subjects: listOf(locale, subjects.map((s) => t(`subjects.${s}`))) })];
}

/**
 * The title and description of a slug page in the page's language. A converter page says what it converts, which other
 * formats the registry converts its source to, and what the options of that pair set, as the reference converter's intro
 * does; it claims nothing about speed or quality.
 */
export function localizeSlugCopy(t: SlugCopyTranslator, parsed: ParsedSlug, locale: string): LocalizedSlugCopy {
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
      const names = { src: nameOf(t, copy.src), tgt: nameOf(t, copy.tgt) };
      const related = relatedTargets(source, [source, target]);
      const sentences = [
        t(copy.group === 'videoToAudio' ? 'pair.lead.extractAudio' : 'pair.lead.convert', names),
        ...(related.length > 0 ? [t('related.pair', { ...names, formats: listOf(locale, related) })] : []),
        ...optionsSentence(t, locale, source, target),
      ];
      return { title: t('pair.title', names), description: sentences.join(' ') };
    }
    case 'format': {
      const name = nameOf(t, copy.name);
      const related = relatedTargets(source, [source]);
      const sentences = [
        t(`format.lead.${copy.group}`, { name }),
        ...(related.length > 0 ? [t('related.format', { name, formats: listOf(locale, related) })] : []),
        ...optionsSentence(t, locale, source, firstTarget(source)),
      ];
      return { title: t('format.title', { name }), description: sentences.join(' ') };
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
