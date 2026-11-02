// @vitest-environment jsdom
import { createElement, useState, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import OptionsModal from '../src/components/OptionsModal';
import { VectorizeOptionsSection } from '../src/components/vectorize/VectorizeOptionsSection';
import { sanitizeOptionsForPair } from '../src/components/workbench/options/options-capabilities';
import type { ConversionOptions } from '../src/lib/types';
import { testMessages } from './helpers/intl-messages';
import { phrasesMissing, phrasesPresent, renderDom, visibleText, type DomElement } from './helpers/rendered-dom';

/**
 * The options dialog of a raster picture traced to SVG shows the tracer's options, named and defaulted as the engine names them, and
 * nothing of the picture options that do not apply to an SVG; the queue keeps only those options for the pair.
 */

const noop = () => undefined;

function dialog(initialOptions: ConversionOptions, locale: 'en' | 'ko' = 'en', targetFormat = 'svg', sourceFormat = 'png'): DomElement {
  return renderDom(createElement(OptionsModal, { filename: `logo.${sourceFormat}`, sourceFormat, targetFormat, initialOptions, onSave: noop, onClose: noop }), locale);
}

describe('the options dialog of a raster to SVG pair', () => {
  it('shows the tracer options in English and none of the picture options', () => {
    const text = visibleText(dialog({}));
    expect(phrasesMissing(text, ['Vector Tracing', 'Preset', 'Mode', 'Advanced'])).toEqual([]);
    expect(phrasesPresent(text, ['Compression Quality', 'Width (px)', 'Resize Fit', 'Strip EXIF'])).toEqual([]);
  });

  it('shows them in Korean', () => {
    const text = visibleText(dialog({}, 'ko'));
    expect(phrasesMissing(text, ['벡터화 설정', '프리셋', '곡선 방식', '고급 설정'])).toEqual([]);
  });

  it('keeps the picture options for other image targets', () => {
    const text = visibleText(dialog({}, 'en', 'webp'));
    expect(phrasesMissing(text, ['Compression Quality'])).toEqual([]);
    expect(phrasesPresent(text, ['Vector Tracing', 'Advanced'])).toEqual([]);
  });

  it('offers no page range for a TIFF, since the tracer reads its first page', () => {
    const text = visibleText(dialog({}, 'en', 'svg', 'tiff'));
    expect(phrasesMissing(text, ['Vector Tracing'])).toEqual([]);
    expect(phrasesPresent(text, ['Page Range'])).toEqual([]);
  });
});

/** What a person reads and does in the tracer section, driven through the DOM of a mounted section. */
interface Mounted {
  container: HTMLElement;
  sent: ConversionOptions[];
}

let mounted: Root | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

async function mountElement(element: ReactElement, locale: 'en' | 'ko'): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  const container = document.createElement('div');
  document.body.appendChild(container);
  mounted = createRoot(container);
  mounted.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: element }));
  await vi.waitFor(() => expect(container.querySelector('[role="radiogroup"]')).not.toBeNull());
  return container;
}

async function mount(initial: ConversionOptions, locale: 'en' | 'ko' = 'en'): Promise<Mounted> {
  const sent: ConversionOptions[] = [];
  function Editable() {
    const [options, setOptions] = useState<ConversionOptions>(initial);
    return createElement(VectorizeOptionsSection, { options, onChange: (next: ConversionOptions) => { sent.push(next); setOptions(next); } });
  }
  return { container: await mountElement(createElement(Editable), locale), sent };
}

const textOf = (container: HTMLElement, id: string | null): string => (id ? container.ownerDocument.getElementById(id)?.textContent?.trim() ?? '' : '');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The radio buttons of the group a person reads under `name`, each with its label, its one-line description and whether it is chosen. */
function radiosOf(container: HTMLElement, name: string): Array<{ label: string; description: string; checked: boolean; element: HTMLInputElement }> {
  const group = [...container.querySelectorAll('[role="radiogroup"]')].find((candidate) => textOf(container, candidate.getAttribute('aria-labelledby')) === name);
  if (!group) throw new Error(`no radio group named ${name}`);
  return [...group.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((element) => ({
    label: textOf(container, element.getAttribute('aria-labelledby')),
    description: textOf(container, element.getAttribute('aria-describedby')),
    checked: element.checked,
    element,
  }));
}

/** Picks the radio a person reads as `label` in the group `name`; a missing radio fails the test instead of passing it. */
function choose(container: HTMLElement, name: string, label: string): void {
  const radio = radiosOf(container, name).find((candidate) => candidate.label === label);
  if (!radio) throw new Error(`no radio ${label} in the group ${name}`);
  radio.element.click();
}

const chosen = (container: HTMLElement, name: string): string | undefined => radiosOf(container, name).find((radio) => radio.checked)?.label;
const disclosure = (container: HTMLElement): HTMLButtonElement => {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.hasAttribute('aria-expanded'));
  if (!button) throw new Error('no disclosure button');
  return button;
};
const byId = <T extends HTMLElement>(container: HTMLElement, id: string): T | null => container.ownerDocument.getElementById(id) as T | null;
const lastVectorize = (run: Mounted) => run.sent.at(-1)?.vectorize;

async function expand(run: Mounted): Promise<void> {
  disclosure(run.container).click();
  await vi.waitFor(() => expect(disclosure(run.container).getAttribute('aria-expanded')).toBe('true'));
}

async function typeInto(input: HTMLInputElement, typed: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set as (value: string) => void;
  setValue.call(input, typed);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
}

describe('the preset and mode radio lists', () => {
  it('lists each preset and mode with a one-line description, and chooses none and spline from the start', async () => {
    const { container } = await mount({});
    expect(radiosOf(container, 'Preset').map(({ label, description }) => [label, description])).toEqual([
      ['none', ''],
      ['bw', 'Black & white line art.'],
      ['poster', 'Flat graphics with few colors.'],
      ['photo', 'Photographs.'],
    ]);
    expect(radiosOf(container, 'Mode').map(({ label, description }) => [label, description])).toEqual([
      ['spline', 'Smooth curves.'],
      ['polygon', 'Straight edges.'],
      ['pixel', 'Preserve pixel edges, for pixel art.'],
    ]);
    expect(chosen(container, 'Preset')).toBe('none');
    expect(chosen(container, 'Mode')).toBe('spline');
  });

  it('lists them in Korean', async () => {
    const { container } = await mount({}, 'ko');
    expect(radiosOf(container, '프리셋').map(({ label, description }) => [label, description])).toEqual([
      ['사용 안 함', ''],
      ['흑백', '흑백 선화에 알맞아요.'],
      ['포스터', '색이 적은 평면 그래픽에 알맞아요.'],
      ['사진', '사진에 알맞아요.'],
    ]);
    expect(radiosOf(container, '곡선 방식').map(({ label, description }) => [label, description])).toEqual([
      ['스플라인', '부드러운 곡선으로 그려요.'],
      ['다각형', '곧은 모서리로 그려요.'],
      ['픽셀', '픽셀 경계를 그대로 살려요. 픽셀 아트에 알맞아요.'],
    ]);
  });

  it('shows the chosen preset and mode of the options it starts from', async () => {
    const { container } = await mount({ vectorize: { preset: 'poster', mode: 'pixel' } });
    expect(chosen(container, 'Preset')).toBe('poster');
    expect(chosen(container, 'Mode')).toBe('pixel');
  });

  it('sends the preset a person picks, and none sends no preset', async () => {
    const run = await mount({});
    choose(run.container, 'Preset', 'photo');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ preset: 'photo' }));
    expect(chosen(run.container, 'Preset')).toBe('photo');
    choose(run.container, 'Preset', 'none');
    await vi.waitFor(() => expect(run.sent.at(-1)?.vectorize).toBeUndefined());
    expect(chosen(run.container, 'Preset')).toBe('none');
  });

  it('sends the mode a person picks', async () => {
    const run = await mount({});
    choose(run.container, 'Mode', 'polygon');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ mode: 'polygon' }));
    expect(chosen(run.container, 'Mode')).toBe('polygon');
  });

  it('makes each list one radio group, so the arrow keys move within it, and names the group by its label', async () => {
    const { container } = await mount({});
    const names = [...container.querySelectorAll('[role="radiogroup"]')].map((group) => new Set([...group.querySelectorAll('input[type="radio"]')].map((radio) => radio.getAttribute('name'))));
    expect(names.map((set) => set.size)).toEqual([1, 1]);
    expect(new Set(names.flatMap((set) => [...set])).size).toBe(2);
    expect(radiosOf(container, 'Preset')).toHaveLength(4);
  });
});

describe('the Advanced disclosure', () => {
  it('starts collapsed with no advanced field shown, and says so to assistive technology', async () => {
    const { container } = await mount({});
    expect(disclosure(container).textContent?.trim()).toBe('Advanced');
    expect(disclosure(container).getAttribute('aria-expanded')).toBe('false');
    expect(disclosure(container).hasAttribute('aria-controls')).toBe(false);
    expect(container.querySelector('input[type="range"]')).toBeNull();
    expect(byId(container, 'opt-vectorize-simplify')).toBeNull();
  });

  it('starts open when the options it starts from set one of its fields, so no value it sends is hidden', async () => {
    for (const vectorize of [{ filterSpeckle: 12 }, { colorPrecision: 3 }, { simplify: 1.5 }]) {
      const { container } = await mount({ vectorize });
      expect(disclosure(container).getAttribute('aria-expanded'), JSON.stringify(vectorize)).toBe('true');
      expect(byId(container, 'opt-vectorize-simplify')).not.toBeNull();
      mounted?.unmount();
    }
  });

  it('opens on click to the three fields and closes again', async () => {
    const run = await mount({});
    await expand(run);
    const controlled = disclosure(run.container).getAttribute('aria-controls') ?? '';
    expect(byId(run.container, controlled)?.querySelectorAll('input[type="range"]')).toHaveLength(2);
    expect(byId(run.container, 'opt-vectorize-simplify')).not.toBeNull();
    disclosure(run.container).click();
    await vi.waitFor(() => expect(disclosure(run.container).getAttribute('aria-expanded')).toBe('false'));
    expect(run.container.querySelector('input[type="range"]')).toBeNull();
  });

  it('is a keyboard operable button', async () => {
    const { container } = await mount({});
    expect(disclosure(container).tagName).toBe('BUTTON');
    expect(disclosure(container).getAttribute('type')).toBe('button');
  });

  it('starts from the engine defaults: speckle 4, 6 bits, no simplification', async () => {
    const run = await mount({});
    await expand(run);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle')?.value).toBe('4');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision')?.value).toBe('6');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle-value')?.value).toBe('4');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value')?.value).toBe('6');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify')?.value).toBe('');
  });

  it('shows what a preset sets for the values the person has not changed, and the changed values as they are', async () => {
    const photo = await mount({ vectorize: { preset: 'photo' } });
    await expand(photo);
    expect(byId<HTMLInputElement>(photo.container, 'opt-vectorize-filter-speckle')?.value).toBe('10');
    expect(byId<HTMLInputElement>(photo.container, 'opt-vectorize-color-precision-value')?.value).toBe('8');
    mounted?.unmount();
    const changed = await mount({ vectorize: { preset: 'photo', filterSpeckle: 2 } });
    expect(byId<HTMLInputElement>(changed.container, 'opt-vectorize-filter-speckle')?.value).toBe('2');
    expect(byId<HTMLInputElement>(changed.container, 'opt-vectorize-filter-speckle-value')?.value).toBe('2');
  });
});

describe('a slider and its number field', () => {
  it('moves the number field with the slider and sends the value', async () => {
    const run = await mount({});
    await expand(run);
    const slider = byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle') as HTMLInputElement;
    await typeInto(slider, '30');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ filterSpeckle: 30 }));
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle-value')?.value).toBe('30');
  });

  it('moves the slider with the number field, whole numbers inside the range only', async () => {
    const run = await mount({});
    await expand(run);
    const field = byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value') as HTMLInputElement;
    await typeInto(field, '3');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ colorPrecision: 3 }));
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision')?.value).toBe('3');
    await typeInto(field, '12');
    await typeInto(field, '2.5');
    expect(lastVectorize(run)).toEqual({ colorPrecision: 3 });
    expect(field.value).toBe('2.5');
  });

  it('brings a number typed past the range to the nearest whole number inside it on leaving the field, and sends it', async () => {
    const run = await mount({});
    await expand(run);
    const speckle = byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle-value') as HTMLInputElement;
    await typeInto(speckle, '200');
    expect(lastVectorize(run)).toBeUndefined();
    speckle.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ filterSpeckle: 128 }));
    expect(speckle.value).toBe('128');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle')?.value).toBe('128');
    const precision = byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value') as HTMLInputElement;
    for (const [typed, kept] of [['0', 1], ['2.6', 3]] as const) {
      await typeInto(precision, typed);
      precision.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ filterSpeckle: 128, colorPrecision: kept }));
      expect(precision.value).toBe(String(kept));
    }
  });

  it('lets the person clear the number field to type another value, and shows the value again on leaving it', async () => {
    const run = await mount({});
    await expand(run);
    const field = byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle-value') as HTMLInputElement;
    await typeInto(field, '');
    expect(field.value).toBe('');
    await typeInto(field, '9');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ filterSpeckle: 9 }));
    await typeInto(field, '');
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await vi.waitFor(() => expect(field.value).toBe('9'));
  });

  it('names the unit in the number field', async () => {
    const run = await mount({});
    await expand(run);
    const text = run.container.textContent ?? '';
    expect(phrasesMissing(text, ['px', 'bit'])).toEqual([]);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle-value')?.getAttribute('aria-label')).toBe('Filter Speckle (px)');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value')?.getAttribute('aria-label')).toBe('Color Precision (bit)');
  });

  it('tells what each field does and the range it takes', async () => {
    const run = await mount({});
    await expand(run);
    expect(phrasesMissing(run.container.textContent ?? '', [
      'Discards patches smaller than this size in pixels (0 to 128).',
      'Significant bits per RGB channel (1 to 8).',
      'Try 1 to 2.5 for a smaller file.',
    ])).toEqual([]);
  });
});

describe('the fields the engine ignores', () => {
  const textUnder = (run: Mounted) => run.container.textContent ?? '';

  it('greys out simplify outside the spline mode and says why, as the engine applies it to splines only', async () => {
    const spline = await mount({});
    await expand(spline);
    expect(byId<HTMLInputElement>(spline.container, 'opt-vectorize-simplify')?.disabled).toBe(false);
    mounted?.unmount();
    for (const mode of ['polygon', 'pixel'] as const) {
      const run = await mount({ vectorize: { mode } });
      await expand(run);
      expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify')?.disabled, mode).toBe(true);
      expect(phrasesMissing(textUnder(run), ['Applies only to the spline mode.'])).toEqual([]);
      mounted?.unmount();
    }
    const korean = await mount({ vectorize: { mode: 'polygon' } }, 'ko');
    await expand(korean);
    expect(phrasesMissing(textUnder(korean), ['스플라인 곡선 방식에만 적용돼요.'])).toEqual([]);
  });

  it('greys out color precision, slider and number field, under the black and white preset and says why', async () => {
    const poster = await mount({ vectorize: { preset: 'poster' } });
    await expand(poster);
    expect(byId<HTMLInputElement>(poster.container, 'opt-vectorize-color-precision')?.disabled).toBe(false);
    mounted?.unmount();
    const run = await mount({ vectorize: { preset: 'bw' } });
    await expand(run);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision')?.disabled).toBe(true);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value')?.disabled).toBe(true);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-filter-speckle')?.disabled).toBe(false);
    expect(phrasesMissing(textUnder(run), ['The black and white preset traces two colors, so this does not apply.'])).toEqual([]);
  });

  it('keeps the values a person typed while a mode or preset greys their field out, and sends them again on switching back', async () => {
    const run = await mount({});
    await expand(run);
    await typeInto(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify') as HTMLInputElement, '1.5');
    await typeInto(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value') as HTMLInputElement, '3');
    choose(run.container, 'Mode', 'polygon');
    choose(run.container, 'Preset', 'bw');
    await vi.waitFor(() => expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision')?.disabled).toBe(true));
    choose(run.container, 'Mode', 'spline');
    choose(run.container, 'Preset', 'none');
    await vi.waitFor(() => expect(lastVectorize(run)).toEqual({ mode: 'spline', simplify: 1.5, colorPrecision: 3 }));
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify')?.value).toBe('1.5');
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value')?.value).toBe('3');
  });

  it('greys a field out as soon as the person picks the mode or preset that ignores it', async () => {
    const run = await mount({});
    await expand(run);
    choose(run.container, 'Mode', 'pixel');
    await vi.waitFor(() => expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify')?.disabled).toBe(true));
    choose(run.container, 'Preset', 'bw');
    await vi.waitFor(() => expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-color-precision-value')?.disabled).toBe(true));
  });
});

describe('typing a simplify tolerance', () => {
  it('sets the minimum of the simplify field to 0, the exclusive minimum of the request schema', async () => {
    const run = await mount({});
    await expand(run);
    expect(byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify')?.getAttribute('min')).toBe('0');
  });

  it('keeps a leading 0 while the person types 0.5, and sends 0.5', async () => {
    const run = await mount({});
    await expand(run);
    const input = byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify') as HTMLInputElement;
    const sent: Array<number | undefined> = [];
    for (const typed of ['0', '0.5']) {
      await typeInto(input, typed);
      sent.push(run.sent.at(-1)?.vectorize?.simplify);
      expect(input.value).toBe(typed);
    }
    expect(sent).toEqual([undefined, 0.5]);
  });

  it('clears the tolerance when the field is emptied', async () => {
    const run = await mount({ vectorize: { simplify: 1.5 } });
    const input = byId<HTMLInputElement>(run.container, 'opt-vectorize-simplify') as HTMLInputElement;
    expect(input.value).toBe('1.5');
    await typeInto(input, '');
    await vi.waitFor(() => expect(run.sent.at(-1)?.vectorize).toBeUndefined());
    expect(input.value).toBe('');
  });
});

describe('applying the options dialog', () => {
  it('sends the queue the values the engine reads: a value typed under a mode that ignores it stays in the dialog and is left out', async () => {
    const saved: ConversionOptions[] = [];
    const closed = vi.fn();
    const container = await mountElement(
      createElement(OptionsModal, { filename: 'logo.png', sourceFormat: 'png', targetFormat: 'svg', initialOptions: {}, onSave: (options: ConversionOptions) => saved.push(options), onClose: closed }),
      'en'
    );
    const run: Mounted = { container, sent: [] };
    await expand(run);
    await typeInto(byId<HTMLInputElement>(container, 'opt-vectorize-simplify') as HTMLInputElement, '1.5');
    choose(container, 'Mode', 'polygon');
    await vi.waitFor(() => expect(byId<HTMLInputElement>(container, 'opt-vectorize-simplify')?.disabled).toBe(true));
    expect(byId<HTMLInputElement>(container, 'opt-vectorize-simplify')?.value).toBe('1.5');
    const apply = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apply Options');
    if (!apply) throw new Error('no Apply Options button');
    apply.click();
    await vi.waitFor(() => expect(saved).toEqual([{ vectorize: { mode: 'polygon' } }]));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('sends the value again once the mode that reads it is back', async () => {
    const saved: ConversionOptions[] = [];
    const container = await mountElement(
      createElement(OptionsModal, { filename: 'logo.png', sourceFormat: 'png', targetFormat: 'svg', initialOptions: {}, onSave: (options: ConversionOptions) => saved.push(options), onClose: noop }),
      'en'
    );
    await expand({ container, sent: [] });
    await typeInto(byId<HTMLInputElement>(container, 'opt-vectorize-simplify') as HTMLInputElement, '1.5');
    choose(container, 'Mode', 'pixel');
    choose(container, 'Mode', 'spline');
    await vi.waitFor(() => expect(byId<HTMLInputElement>(container, 'opt-vectorize-simplify')?.disabled).toBe(false));
    [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Apply Options')?.click();
    await vi.waitFor(() => expect(saved).toEqual([{ vectorize: { mode: 'spline', simplify: 1.5 } }]));
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

  it('drops every option of the sections a raster to SVG pair does not show, for a PNG and for a TIFF source', () => {
    const hidden: ConversionOptions = {
      quality: 80, width: 100, height: 50, fit: 'cover', stripMetadata: true, pages: '1-2', orientation: 'landscape', ocrEnabled: true,
      ocrLanguage: 'eng', password: 'secret', compressionLevel: 9, delimiter: ';', sheetIndex: 1, audioBitrate: '128k', videoFps: 30,
      trim: { start: '0', end: '1' },
    };
    for (const source of ['png', 'tiff']) {
      expect(sanitizeOptionsForPair({ ...hidden, vectorize: { mode: 'pixel' } }, source, 'svg'), source).toEqual({ vectorize: { mode: 'pixel' } });
    }
  });

  it('drops the tracer options for any other pair', () => {
    expect(sanitizeOptionsForPair({ quality: 80, vectorize: { preset: 'bw' } }, 'png', 'webp')).toEqual({ quality: 80 });
  });
});
