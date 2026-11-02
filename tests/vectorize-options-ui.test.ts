import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import OptionsModal from '../src/components/OptionsModal';
import { sanitizeOptionsForPair } from '../src/components/vectorize/pair-options';
import type { ConversionOptions } from '../src/lib/types';
import { attrOf, phrasesMissing, phrasesPresent, renderDom, select, visibleText, type DomElement } from './helpers/rendered-dom';

/**
 * The options dialog of a raster picture traced to SVG shows the tracer's options, named and defaulted as the engine names them, and
 * nothing of the picture options that do not apply to an SVG; the queue keeps only those options for the pair.
 */

const noop = () => undefined;

function dialog(initialOptions: ConversionOptions, locale: 'en' | 'ko' = 'en', targetFormat = 'svg'): DomElement {
  return renderDom(createElement(OptionsModal, { filename: 'logo.png', sourceFormat: 'png', targetFormat, initialOptions, onSave: noop, onClose: noop }), locale);
}

/** The value a field shows: an input's value attribute, or the value of the option a select marks as selected. */
const valueOf = (root: DomElement, id: string): string | null => {
  const input = select(root, 'input').find((element) => attrOf(element, 'id') === id);
  if (input) return attrOf(input, 'value');
  const choice = select(root, 'select').find((element) => attrOf(element, 'id') === id);
  const picked = choice ? select(choice, 'option').find((option) => attrOf(option, 'selected') !== null) : undefined;
  return picked ? attrOf(picked, 'value') : null;
};

describe('the options dialog of a raster to SVG pair', () => {
  it('shows the tracer options in English and none of the picture options', () => {
    const text = visibleText(dialog({}));
    expect(phrasesMissing(text, ['Vector Tracing', 'Preset', 'Mode', 'Filter Speckle (px)', 'Color Precision (bits)', 'Simplify (px)'])).toEqual([]);
    expect(phrasesPresent(text, ['Compression Quality', 'Width (px)', 'Resize Fit', 'Strip EXIF'])).toEqual([]);
  });

  it('shows them in Korean', () => {
    const text = visibleText(dialog({}, 'ko'));
    expect(phrasesMissing(text, ['벡터화 설정', '프리셋', '곡선 방식', '잡티 제거(px)', '색 정밀도(비트)', '단순화(px)'])).toEqual([]);
  });

  it('starts from the engine defaults: spline, speckle 4, 6 bits, no simplification', () => {
    const root = dialog({});
    expect(valueOf(root, 'opt-vectorize-mode')).toBe('spline');
    expect(valueOf(root, 'opt-vectorize-filter-speckle')).toBe('4');
    expect(valueOf(root, 'opt-vectorize-color-precision')).toBe('6');
    expect(valueOf(root, 'opt-vectorize-simplify')).toBe('');
  });

  it('shows what a preset sets for the values the person has not changed, and the changed values as they are', () => {
    const photo = dialog({ vectorize: { preset: 'photo' } });
    expect(valueOf(photo, 'opt-vectorize-filter-speckle')).toBe('10');
    expect(valueOf(photo, 'opt-vectorize-color-precision')).toBe('8');
    const changed = dialog({ vectorize: { preset: 'photo', filterSpeckle: 2 } });
    expect(valueOf(changed, 'opt-vectorize-filter-speckle')).toBe('2');
  });

  it('keeps the picture options for other image targets', () => {
    const text = visibleText(dialog({}, 'en', 'webp'));
    expect(phrasesMissing(text, ['Compression Quality'])).toEqual([]);
    expect(phrasesPresent(text, ['Vector Tracing'])).toEqual([]);
  });
});

describe('the options a queue item keeps', () => {
  it('keeps only valid tracer options for a raster to SVG pair', () => {
    const kept = sanitizeOptionsForPair({ quality: 80, width: 100, vectorize: { preset: 'poster', colorPrecision: 12, simplify: 1.5 } }, 'jpg', 'svg');
    expect(kept).toEqual({ vectorize: { preset: 'poster', simplify: 1.5 } });
    expect(sanitizeOptionsForPair({ quality: 80 }, 'png', 'svg')).toEqual({});
  });

  it('drops the tracer options for any other pair', () => {
    expect(sanitizeOptionsForPair({ quality: 80, vectorize: { preset: 'bw' } }, 'png', 'webp')).toEqual({ quality: 80 });
  });
});
