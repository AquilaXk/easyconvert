import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import OptionsModal from '../src/components/OptionsModal';
import { isSameFormat } from '../src/lib/format-aliases';
import { CATEGORY_WORDS } from '../src/lib/category-words';
import { parseConverterSlug } from '../src/lib/slug-parser';
import { FORMAT_REGISTRY, getAvailableTargetFormats } from '../src/lib/registry';
import { slugPageCopy, type TestLocale } from './helpers/intl';
import { allElements, attrOf, renderDom } from './helpers/rendered-dom';
import { REGISTRY_WIDE_TIMEOUT_MS } from './helpers/registry-wide-timeout';

/**
 * The intro of a converter page, which is also its meta description: what the page converts, other targets of its source
 * and, on a pair page, what the options dialog of that pair sets. It reads as one or two short sentences, as the intros of
 * comparable converters do.
 */

const LOCALES: readonly TestLocale[] = ['en', 'ko'];
const FIRST_SENTENCE_MAX = 120;
const INTRO_MAX = 160;

const firstSentence = (text: string) => text.split(/(?<=[.요])\s/)[0];

const registeredPairs = Object.keys(FORMAT_REGISTRY)
  .flatMap((source) =>
    getAvailableTargetFormats(source)
      .filter(({ id }) => !isSameFormat(id, source))
      .map(({ id }) => `${source}-to-${id}`)
  )
  .filter((slug) => parseConverterSlug(slug)?.copy.kind === 'pair');
const formatPages = Object.keys(FORMAT_REGISTRY).map((id) => `${id}-converter`);
const categoryPages = Object.keys(CATEGORY_WORDS).map((word) => `${word}-converter`);

describe('the intro of a converter page', () => {
  it.each([
    ['png-to-jpg', 'en', 'Convert PNG files to JPG online. Other targets include WEBP, AVIF, TIFF, GIF, and BMP. Options include image size, quality, and metadata removal.'],
    ['png-to-jpg', 'ko', 'PNG 파일을 JPG 형식으로 온라인에서 변환해요. WEBP, AVIF, TIFF, GIF, BMP 형식으로도 바꿀 수 있어요. 옵션에서 이미지 크기, 품질, 메타데이터 제거 등을 정할 수 있어요.'],
    ['mp4-to-mp3', 'en', 'Extract the sound of MP4 files as MP3 files online. Other targets include WEBM, MKV, AVI, and MOV. Options include bitrate, sample rate, and audio channels.'],
    ['docx-to-pdf', 'en', 'Convert DOCX files to PDF online. Other targets include HTML, TXT, MD, EPUB, and ODT.'],
    ['pdf-to-docx', 'en', 'Convert PDF files to DOCX online. Other targets include HTML, MD, RTF, TXT, and EPUB.'],
    ['csv-to-xlsx', 'en', 'Convert CSV files to XLSX online. Other targets include JSON, TSV, PARQUET, HTML, and YAML.'],
    ['jpeg-to-png', 'en', 'Convert JPEG files to PNG online. Other targets include WEBP, AVIF, TIFF, GIF, and BMP. Options include image size, quality, and metadata removal.'],
    ['video-converter', 'en', 'Convert videos online. Targets include WEBM, MKV, AVI, MOV, and MP3.'],
    ['video-converter', 'ko', '동영상 파일을 온라인에서 변환해요. WEBM, MKV, AVI, MOV, MP3 등으로 바꿀 수 있어요.'],
    ['ttf-converter', 'en', 'Convert TTF fonts online. Targets include WOFF, WOFF2, EOT, OTF, and SVG.'],
    ['ttf-converter', 'ko', 'TTF 글꼴 파일을 온라인에서 변환해요. WOFF, WOFF2, EOT, OTF, SVG 등으로 바꿀 수 있어요.'],
    ['dxf-converter', 'en', 'Convert DXF drawings online. Targets include PDF, SVG, PNG, ZIP, and JPG.'],
  ] as const)('of %s in %s says what it converts, other targets and the options', (slug, locale, intro) => {
    expect(slugPageCopy(slug, locale).description).toBe(intro);
  });

  it.each([
    ['video-converter', 'en', 'Convert videos online.'],
    ['video-converter', 'ko', '동영상 파일을 온라인에서 변환해요.'],
    ['document-converter', 'en', 'Convert documents online.'],
    ['image-converter', 'en', 'Convert images online.'],
    ['image-converter', 'ko', '이미지 파일을 온라인에서 변환해요.'],
  ] as const)('of the category page %s in %s names the category once', (slug, locale, lead) => {
    expect(firstSentence(slugPageCopy(slug, locale).description)).toBe(lead);
  });

  it.each(LOCALES)('in %s keeps the first sentence within 120 characters and the intro within 160 on every page', (locale) => {
    const over = [...registeredPairs, ...formatPages, ...categoryPages].flatMap((slug) => {
      const { description } = slugPageCopy(slug, locale);
      const lead = firstSentence(description);
      return lead.length > FIRST_SENTENCE_MAX || description.length > INTRO_MAX ? [`${slug}: ${description}`] : [];
    });
    expect(over).toEqual([]);
  });

  it('names each format in capitals and never calls a font or a drawing a document', () => {
    // /pdfa-converter is the page that makes PDF/A files, not the page of the format `pdfa`.
    const misnamed = formatPages.filter((slug) => !categoryPages.includes(slug) && slug !== 'pdfa-converter').filter((slug) => {
      const id = slug.replace(/-converter$/, '');
      const lead = firstSentence(slugPageCopy(slug, 'en').description);
      const ownNoun = ['font', 'cad'].includes(FORMAT_REGISTRY[id].category);
      return !lead.includes(id.toUpperCase()) || (ownNoun && /document/i.test(lead));
    });
    expect(misnamed).toEqual([]);
  });

  it('finds no targets for a name that is a property of every object', () => {
    expect(['constructor', '__proto__'].map((name) => getAvailableTargetFormats(name))).toEqual([[], []]);
  });

  it.each(LOCALES)('in %s names no options on a format page, whose options depend on the target', (locale) => {
    const word = locale === 'en' ? /option/i : /옵션/;
    const naming = [...formatPages, ...categoryPages].filter((slug) => word.test(slugPageCopy(slug, locale).description));
    expect(naming).toEqual([]);
  });
});

/** What each control of the options dialog sets, as the English intro words it. */
const CONTROL_SUBJECTS: ReadonlyArray<[controlId: string, subject: string]> = [
  ['opt-image-width', 'image size'],
  ['opt-image-quality', 'quality'],
  ['opt-strip-metadata', 'metadata removal'],
  ['opt-doc-pages', 'page range'],
  ['opt-doc-orientation', 'page orientation'],
  ['opt-doc-ocr-lang', 'text recognition'],
  ['opt-doc-password', 'password'],
  ['opt-video-codec', 'video codec'],
  ['opt-video-fps', 'frame rate'],
  ['opt-video-width', 'resolution'],
  ['opt-audio-bitrate', 'bitrate'],
  ['opt-audio-sample-rate', 'sample rate'],
  ['opt-audio-channels', 'audio channels'],
  ['opt-data-delimiter', 'delimiter'],
  ['opt-data-sheet-index', 'sheet choice'],
  ['opt-archive-compression', 'compression level'],
];

function subjectsTheDialogRenders(source: string, target: string): string[] {
  const dialog = renderDom(
    createElement(OptionsModal, {
      filename: `file.${source}`, sourceFormat: source, targetFormat: target,
      initialOptions: {}, onSave: () => undefined, onClose: () => undefined,
    })
  );
  const ids = allElements(dialog).map((element) => attrOf(element, 'id'));
  return CONTROL_SUBJECTS.filter(([id]) => ids.includes(id))
    .sort(([a], [b]) => ids.indexOf(a) - ids.indexOf(b))
    .map(([, subject]) => subject);
}

/** The intro's options sentence for `subjects` in English, as the dialog of the pair would be described. */
function optionsSentence(subjects: string[]): string {
  if (subjects.length === 1) return `Options include the ${subjects[0]}.`;
  return `Options include ${new Intl.ListFormat('en', { type: 'conjunction' }).format(subjects)}.`;
}

/** The pair pages that name options are those of images, video and audio; a document, font, archive or data pair page does not. */
const OPTION_INTRO_CATEGORIES = ['image', 'video', 'audio'];

describe('the options a pair page names', () => {
  it('are the first options its dialog renders for an image, video or audio source, in the dialog order, and none for any other source', () => {
    const differing = registeredPairs.flatMap((slug) => {
      const [source, target] = slug.split('-to-');
      const rendered = OPTION_INTRO_CATEGORIES.includes(FORMAT_REGISTRY[source].category)
        ? subjectsTheDialogRenders(source, target).slice(0, 3)
        : [];
      const { description } = slugPageCopy(slug, 'en');
      const named = rendered.length === 0 ? !/option/i.test(description) : description.endsWith(` ${optionsSentence(rendered)}`);
      return named ? [] : [`${slug}: dialog ${rendered.join(', ')} | intro ${description}`];
    });
    expect(differing).toEqual([]);
  }, REGISTRY_WIDE_TIMEOUT_MS);

  it.each([
    ['png-to-hocr', 'en', 'Options include the text recognition.'],
    ['png-to-hocr', 'ko', '문자 인식 옵션을 정할 수 있어요.'],
    ['png-to-jpg', 'ko', '옵션에서 이미지 크기, 품질, 메타데이터 제거 등을 정할 수 있어요.'],
  ] as const)('of %s in %s reads naturally with one subject or several', (slug, locale, sentence) => {
    expect(slugPageCopy(slug, locale).description.endsWith(sentence), slugPageCopy(slug, locale).description).toBe(true);
  });
});
