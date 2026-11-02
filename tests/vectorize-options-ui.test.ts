// @vitest-environment jsdom
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OptionsModal from '../src/components/OptionsModal';
import { VectorizeOptionsSection } from '../src/components/vectorize/VectorizeOptionsSection';
import { sanitizeOptionsForPair } from '../src/components/workbench/options/options-capabilities';
import type { ConversionOptions } from '../src/lib/types';
import { testMessages } from './helpers/intl-messages';
import { attrOf, phrasesMissing, phrasesPresent, renderDom, select, visibleText, type DomElement } from './helpers/rendered-dom';

/**
 * The options dialog of a raster picture traced to SVG shows the tracer's options, named and defaulted as the engine names them, and
 * nothing of the picture options that do not apply to an SVG; the queue keeps only those options for the pair.
 */

const noop = () => undefined;

function dialog(initialOptions: ConversionOptions, locale: 'en' | 'ko' = 'en', targetFormat = 'svg', sourceFormat = 'png'): DomElement {
  return renderDom(createElement(OptionsModal, { filename: `logo.${sourceFormat}`, sourceFormat, targetFormat, initialOptions, onSave: noop, onClose: noop }), locale);
}

const field = (root: DomElement, id: string): DomElement | undefined => select(root, 'input').find((element) => attrOf(element, 'id') === id);
const isDisabled = (root: DomElement, id: string): boolean => attrOf(field(root, id) as DomElement, 'disabled') !== null;

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

  it('offers no page range for a TIFF, since the tracer reads its first page', () => {
    const text = visibleText(dialog({}, 'en', 'svg', 'tiff'));
    expect(phrasesMissing(text, ['Vector Tracing'])).toEqual([]);
    expect(phrasesPresent(text, ['Page Range'])).toEqual([]);
  });

  it('greys out simplify outside the spline mode and says why, as the engine applies it to splines only', () => {
    expect(isDisabled(dialog({}), 'opt-vectorize-simplify')).toBe(false);
    for (const mode of ['polygon', 'pixel'] as const) {
      const root = dialog({ vectorize: { mode } });
      expect(isDisabled(root, 'opt-vectorize-simplify'), mode).toBe(true);
      expect(phrasesMissing(visibleText(root), ['Applies only to the Spline mode.'])).toEqual([]);
    }
    expect(phrasesMissing(visibleText(dialog({ vectorize: { mode: 'polygon' } }, 'ko')), ['스플라인 곡선 방식에만 적용돼요.'])).toEqual([]);
  });

  it('greys out color precision under the black and white preset and says why, as that preset traces two colors', () => {
    expect(isDisabled(dialog({ vectorize: { preset: 'poster' } }), 'opt-vectorize-color-precision')).toBe(false);
    const root = dialog({ vectorize: { preset: 'bw' } });
    expect(isDisabled(root, 'opt-vectorize-color-precision')).toBe(true);
    expect(phrasesMissing(visibleText(root), ['The black and white preset traces two colors, so this does not apply.'])).toEqual([]);
  });

  it('lets simplify take any value above 0, as the request schema does', () => {
    expect(attrOf(field(dialog({}), 'opt-vectorize-simplify') as DomElement, 'min')).toBe('0');
  });
});

describe('typing a simplify tolerance', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount();
    root = undefined;
    vi.unstubAllGlobals();
  });

  it('keeps a leading 0 while the person types 0.5, and sends 0.5', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const sent: Array<number | undefined> = [];
    function Editable() {
      const [options, setOptions] = useState<ConversionOptions>({});
      return createElement(VectorizeOptionsSection, { options, onChange: (next: ConversionOptions) => { sent.push(next.vectorize?.simplify); setOptions(next); } });
    }
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(Editable) }));
    await vi.waitFor(() => expect(container.querySelector('#opt-vectorize-simplify')).not.toBeNull());
    const input = container.querySelector('#opt-vectorize-simplify') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (value: string) => void;
    for (const typed of ['0', '0.5']) {
      setValue.call(input, typed);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(sent).toHaveLength(typed === '0' ? 1 : 2));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(input.value).toBe(typed);
    }
    expect(sent).toEqual([undefined, 0.5]);
  });
});

describe('the options a queue item keeps', () => {
  it('keeps only valid tracer options for a raster to SVG pair', () => {
    const kept = sanitizeOptionsForPair({ quality: 80, width: 100, vectorize: { preset: 'poster', colorPrecision: 12, simplify: 1.5 } }, 'jpg', 'svg');
    expect(kept).toEqual({ vectorize: { preset: 'poster', simplify: 1.5 } });
    expect(sanitizeOptionsForPair({ quality: 80 }, 'png', 'svg')).toEqual({});
  });

  it('drops the options the engine ignores for the chosen mode or preset', () => {
    expect(sanitizeOptionsForPair({ vectorize: { mode: 'polygon', simplify: 1.5 } }, 'png', 'svg')).toEqual({ vectorize: { mode: 'polygon' } });
    expect(sanitizeOptionsForPair({ vectorize: { preset: 'bw', colorPrecision: 3, filterSpeckle: 8 } }, 'gif', 'svg')).toEqual({ vectorize: { preset: 'bw', filterSpeckle: 8 } });
  });

  it('drops the tracer options for any other pair', () => {
    expect(sanitizeOptionsForPair({ quality: 80, vectorize: { preset: 'bw' } }, 'png', 'webp')).toEqual({ quality: 80 });
  });
});
