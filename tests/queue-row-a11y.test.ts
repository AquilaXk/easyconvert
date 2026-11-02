import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import QueueItemRow from '../src/components/workbench/QueueItemRow';
import type { ConversionQueueItem } from '../src/lib/types';
import { allElements, attrOf, renderDom, visibleText, type DomElement } from './helpers/rendered-dom';
import type { TestLocale } from './helpers/intl-messages';
import { PLAN_MAX_FILE_BYTES } from '../src/lib/plan-limits';

/**
 * A file row as assistive technology reads it: the target select is the one control that states the conversion, so its
 * accessible name says which file converts from what to what and where the conversion stands, as the row shows sighted
 * people with the source badge, the arrow and the status.
 */

/** The buttons of a rendered tree with their accessible names: `aria-label` when present, else the text inside. */
const buttonNames = (root: DomElement) =>
  allElements(root)
    .filter((element) => element.tagName === 'button' || attrOf(element, 'role') === 'button')
    .map((button) => attrOf(button, 'aria-label') ?? visibleText(button));

function rowOf(item: Partial<ConversionQueueItem>, locale: TestLocale) {
  const noop = () => undefined;
  const row: ConversionQueueItem = {
    id: 'row-1', file: new File([], 'photo.png'), name: 'photo.png', size: 2048, sourceFormat: 'png', targetFormat: 'jpg',
    status: 'ready', progress: 0, options: {}, ...item,
  };
  return renderDom(
    createElement(QueueItemRow, {
      item: row, isFormatSelectorOpen: false, onToggleFormatSelector: noop, onCloseFormatSelector: noop,
      onSelectTargetFormat: noop, onOpenOptions: noop, onRemove: noop,
    }),
    locale
  );
}

describe('the target select of a file row', () => {
  it.each([
    [{}, 'ko', 'photo.png: PNG 파일을 JPG 형식으로 변환, 준비됨'],
    [{}, 'en', 'photo.png: convert PNG to JPG, ready'],
    [{ status: 'converting', progress: 40 }, 'en', 'photo.png: convert PNG to JPG, converting'],
    [{ status: 'completed', resultUrl: 'blob:x', resultSize: 10 }, 'ko', 'photo.png: PNG 파일을 JPG 형식으로 변환, 완료'],
    [{ status: 'error', error: { code: 'conversionFailed' } }, 'en', 'photo.png: convert PNG to JPG, failed'],
    [{ targetFormat: '' }, 'en', 'photo.png: select format for PNG'],
    [{ targetFormat: '' }, 'ko', 'photo.png: PNG 파일의 변환 형식 선택'],
  ] as const)('of %o in %s states the conversion and its state', (item, locale, name) => {
    expect(buttonNames(rowOf(item as Partial<ConversionQueueItem>, locale))).toContain(name);
  });
});

const alertOf = (row: DomElement) => allElements(row).filter((element) => attrOf(element, 'role') === 'alert').map(visibleText);

describe('a file row that cannot start', () => {
  it.each([
    ['a file over the limit', 'en', { size: PLAN_MAX_FILE_BYTES.anonymous + 1 }, /exceeds the 1 GiB limit/, /, can't convert$/],
    ['a password the target cannot take', 'en', { name: 'notes.pdf', sourceFormat: 'pdf', targetFormat: 'zip', options: { password: '비밀번호' } }, /password/i, /, can't convert$/],
    ['a file over the limit', 'ko', { size: PLAN_MAX_FILE_BYTES.anonymous + 1 }, /1 GiB/, /, 변환할 수 없음$/],
  ] as const)('reads %s in %s as one that cannot convert, names what blocks it, and shows no failure or retry', (_case, locale, item, reason, state) => {
    const row = rowOf(item as Partial<ConversionQueueItem>, locale);
    const select = buttonNames(row).find((name) => name.includes(locale === 'en' ? ': convert ' : ' 형식으로 변환'));
    expect(select).toMatch(state);
    expect(alertOf(row)).toEqual([expect.stringMatching(reason)]);
    expect(visibleText(row)).not.toMatch(/Failed|실패/);
    expect(buttonNames(row).filter((name) => /Retry|다시 시도/.test(name))).toEqual([]);
  });
});

describe('a file row whose conversion ran and failed', () => {
  it('shows the failure and its reason in the row, as its target select states it, and offers no retry of its own', () => {
    const row = rowOf({ status: 'error', error: { code: 'conversionFailed' } }, 'en');
    expect(buttonNames(row)).toContain('photo.png: convert PNG to JPG, failed');
    expect(visibleText(row)).toContain('Failed');
    expect(alertOf(row)).toEqual(['Conversion failed. Try another format or try again.']);
    expect(buttonNames(row).filter((name) => /Retry/.test(name))).toEqual([]);
  });
});
