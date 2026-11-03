// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import FormatPickerButton from '../src/components/workbench/FormatPickerButton';
import { getAllFormats, getAvailableTargetFormats } from '../src/lib/registry';
import type { FormatDefinition } from '../src/lib/types';
import { testMessages } from './helpers/intl-messages';
import { changeLayout, layOutPage, measurements, moveScreen, restorePage, screen, settled } from './helpers/picker-screen';
import { REGISTRY_WIDE_TIMEOUT_MS } from './helpers/registry-wide-timeout';

/**
 * The format picker as a person drives it: a popover under its trigger with a search field, a category column and a grid
 * of formats. Each format appears once under its own name, the current one is marked, the keyboard moves through the grid,
 * and a mouse press in WebKit (which blurs the search without focusing what was pressed) does not close it.
 */

let root: Root | undefined;
let onSelect: Mock<(formatId: string) => void>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  layOutPage();
  onSelect = vi.fn<(formatId: string) => void>();
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restorePage();
});

interface PickerCase {
  selected?: string;
  locale?: 'en' | 'ko';
  disabled?: boolean;
  /** The source whose targets the picker lists; none lists every format, as the source tile does. */
  source?: string;
  available?: FormatDefinition[];
  /** The trigger sits in a box that clips its overflow, as a card or a scrolling list would. */
  clipped?: boolean;
}

/** A trigger as the pages draw one; `mountCase` presses it. */
function Harness({ selected, source, available, disabled, clipped }: Readonly<PickerCase>) {
  const button = createElement(FormatPickerButton, {
    testId: 'trigger', className: '', sourceFormat: source, availableFormats: available, selectedFormatId: selected, disabled, onSelect,
    children: 'JPG',
  });
  return clipped ? createElement('div', { style: { overflow: 'hidden' } }, button) : button;
}

function render(picker: PickerCase) {
  const { locale = 'en' } = picker;
  act(() =>
    root!.render(
      createElement(NextIntlClientProvider, {
        locale, messages: testMessages(locale), timeZone: 'UTC',
        children: createElement('div', null, createElement('header', { 'data-sticky-header': '' }), createElement(Harness, picker)),
      })
    )
  );
}

function mountCase(picker: PickerCase) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render(picker);
  act(() => trigger().click());
}

const trigger = () => document.querySelector<HTMLButtonElement>('[data-testid=trigger]')!;
const isClosed = () => popover() === null && trigger().getAttribute('aria-expanded') === 'false';

const mount = (selected = 'jpg') => mountCase({ selected, source: 'png', available: getAvailableTargetFormats('png') });

function unmount() {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
}

const popover = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const search = () => popover()!.querySelector<HTMLInputElement>('input[type=text]')!;
const formatButtons = () => [...popover()!.querySelectorAll<HTMLButtonElement>('[data-format]')];
const formatNames = () => formatButtons().map((button) => button.textContent);
const categoryButtons = () => [...popover()!.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')];
const accessibleName = (button: HTMLElement) => button.getAttribute('aria-label') ?? button.textContent;
const focusedName = () => (document.activeElement as HTMLElement | null)?.textContent;

function press(target: Element, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

function typeInto(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the format picker popover', () => {
  it('names each format once, folding an alias into the format it stands for', () => {
    mount();
    expect(formatNames().filter((name) => name === 'JPG')).toHaveLength(1);
    expect(formatNames()).not.toContain('JPEG');
    expect(formatNames()).toContain('TIFF');
    expect(formatNames()).not.toContain('TIF');
  });

  it('opens on the image category for an image source when it is passed no list of targets', () => {
    mountCase({ source: 'png' });
    expect(categoryButtons()[0].getAttribute('aria-pressed')).toBe('true');
    expect(formatNames()).toEqual(expect.arrayContaining(['WEBP', 'JPG', 'AVIF']));
  });

  it('lists the formats of a category alphabetically by label, as the reference does', () => {
    mountCase({ source: 'cr2', available: getAvailableTargetFormats('cr2') });
    expect(formatNames()).toEqual(['AVIF', 'BMP', 'EPS', 'EXR', 'GIF', 'ICO', 'JPG', 'PNG', 'PSD', 'TIFF', 'ULTRAHDR', 'WEBP']);
  });

  it('says so, and lists no format, for a source with no targets', () => {
    mountCase({ source: 'xyz', available: [] });
    expect(popover()!.textContent).toMatch(/No supported output formats for this file/);
    expect(formatButtons()).toHaveLength(0);
  });

  it('offers no catch-all choice, only formats', () => {
    mount();
    expect(popover()!.textContent).not.toMatch(/any format/i);
  });

  it('marks the current format, and only it, also when the row names it by an alias', () => {
    mount('jpeg');
    const current = formatButtons().filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current.map((button) => button.textContent)).toEqual(['JPG']);
  });

  it('opens with the search focused, filters as one types and takes the first match with Enter', () => {
    mount();
    expect(document.activeElement).toBe(search());
    typeInto(search(), 'web');
    expect(formatNames()).toEqual(['WEBP']);
    press(search(), 'Enter');
    expect(onSelect).toHaveBeenCalledWith('webp');
  });

  it('takes nothing with Enter in an empty search', () => {
    mount();
    press(search(), 'Enter');
    expect(onSelect).not.toHaveBeenCalled();
    expect(popover()).not.toBeNull();
  });

  it('finds a format offered only under an alias by the name it stands for', () => {
    mountCase({ source: '7z', available: getAvailableTargetFormats('7z') });
    typeInto(search(), 'tgz');
    expect(formatNames()).toEqual(['TAR.GZ']);
  });

  it('leaves Space on a format to the button, so it chooses the format and types nothing into the search', () => {
    mount();
    press(search(), 'ArrowDown');
    const focused = document.activeElement as HTMLButtonElement;
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      focused.dispatchEvent(space);
    });
    expect(space.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(search().value).toBe('');
  });

  it('names a format that shares its extension with another by its own name, as its trigger does', () => {
    mountCase({ selected: 'ultrahdr', source: 'cr2', available: getAvailableTargetFormats('cr2') });
    expect(formatNames().filter((name) => name === 'JPG')).toHaveLength(1);
    const current = formatButtons().filter((button) => button.getAttribute('aria-current') === 'true');
    expect(current.map((button) => button.textContent)).toEqual(['ULTRAHDR']);
    expect(new Set(formatButtons().map(accessibleName)).size).toBe(formatButtons().length);
  });

  it('stays open and follows its trigger when the page scrolls, keeping focus inside, as the reference popover does', async () => {
    mount();
    await settled();
    expect(popover()!.style.top).toBe('234px');
    await moveScreen({ trigger: new DOMRect(100, -100, 128, 32) });
    expect(popover()).not.toBeNull();
    expect(popover()!.style.top).toBe('-66px');
    expect(popover()!.contains(document.activeElement)).toBe(true);
  });

  it('closes when another picker on the page opens, so one is open at a time', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const button = (testId: string) => createElement(FormatPickerButton, { testId, className: '', onSelect, children: testId });
    act(() =>
      root!.render(
        createElement(NextIntlClientProvider, {
          locale: 'en', messages: testMessages('en'), timeZone: 'UTC',
          children: createElement('div', null, button('first'), button('second')),
        })
      )
    );
    const [first, second] = ['first', 'second'].map((id) => document.querySelector<HTMLButtonElement>(`[data-testid=${id}]`)!);
    act(() => first.click());
    act(() => {
      second.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      second.click();
    });
    expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
    expect([first, second].map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });

  it('moves through the grid of three columns with the arrow keys and back to the search above the first row', () => {
    mount();
    const names = formatNames();
    press(search(), 'ArrowDown');
    expect(focusedName()).toBe(names[0]);
    press(document.activeElement!, 'ArrowRight');
    expect(focusedName()).toBe(names[1]);
    press(document.activeElement!, 'ArrowDown');
    expect(focusedName()).toBe(names[4]);
    press(document.activeElement!, 'ArrowLeft');
    expect(focusedName()).toBe(names[3]);
    press(document.activeElement!, 'ArrowUp');
    expect(focusedName()).toBe(names[0]);
    press(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(search());
  });

  it('sends a letter typed on a format to the search', () => {
    mount();
    press(search(), 'ArrowDown');
    press(document.activeElement!, 'f');
    expect(document.activeElement).toBe(search());
    expect(search().value).toBe('f');
    expect(formatNames()).toContain('GIF');
    expect(formatNames()).not.toContain('JPG');
  });

  it.each(['Escape', 'choosing a format'])('hands focus back to its trigger on %s by scrolling to it, since the trigger may be off screen', (how) => {
    mount();
    const focus = vi.spyOn(trigger(), 'focus');
    if (how === 'Escape') press(search(), 'Escape');
    else act(() => formatButtons()[0].click());
    expect(isClosed()).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith();
  });

  it('closes when focus lands outside of it without a pointer press, as a screen reader moving to another control does', () => {
    mount();
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => outside.focus());
    expect(isClosed()).toBe(true);
  });

  it('closes when its trigger becomes disabled, and stays closed once the trigger is enabled again', () => {
    mount();
    render({ disabled: true });
    expect(isClosed()).toBe(true);
    render({ disabled: false });
    expect(isClosed()).toBe(true);
  });

  it('gives every format button the classes that wrap a long label and no hover title, so ULTRAHDR is not cut short (jsdom lays nothing out, so this pins the class contract)', () => {
    mountCase({ selected: 'ultrahdr', source: 'cr2', available: getAvailableTargetFormats('cr2') });
    const long = formatButtons().find((button) => button.textContent === 'ULTRAHDR')!;
    expect(formatButtons().filter((button) => button.title)).toEqual([]);
    for (const button of [long, ...formatButtons()]) {
      expect(button.classList.contains('truncate')).toBe(false);
      expect(button.className).not.toMatch(/overflow-hidden|text-ellipsis|whitespace-nowrap/);
      expect(button.className).toContain('[overflow-wrap:anywhere]');
    }
  });

  it('shows no category column for a list of one category, so its grid takes the whole popover', () => {
    mountCase({ source: 'rar', available: getAvailableTargetFormats('rar') });
    expect(categoryButtons()).toHaveLength(0);
    expect(formatNames()).toEqual(['7Z', 'TAR', 'TAR.BZ2', 'TAR.GZ', 'ZIP']);
  });

  it('keeps the category column for a list of several categories', () => {
    mountCase({ source: 'cr2', available: getAvailableTargetFormats('cr2') });
    expect(categoryButtons().length).toBeGreaterThan(1);
  });

  it('starts the grid at its top for each category', () => {
    const scrollTop = vi.spyOn(Element.prototype, 'scrollTop', 'set');
    mount();
    scrollTop.mockClear();
    act(() => categoryButtons()[1].click());
    expect(scrollTop).toHaveBeenCalledWith(0);
  });

  it.each(['f', '7', '.', '+', '_', '-'])('sends %s typed on a format to the search', (key) => {
    mount();
    press(search(), 'ArrowDown');
    press(document.activeElement!, key);
    expect(document.activeElement).toBe(search());
    expect(search().value).toBe(key);
  });

  it('leaves a character no format name holds, like ?, to the browser', () => {
    mount();
    press(search(), 'ArrowDown');
    const focused = document.activeElement;
    const question = new KeyboardEvent('keydown', { key: '?', bubbles: true, cancelable: true });
    act(() => {
      focused!.dispatchEvent(question);
    });
    expect(question.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(search().value).toBe('');
  });

  it('closes on Escape and hands focus back to its trigger', () => {
    mount();
    press(search(), 'ArrowDown');
    press(document.activeElement!, 'Escape');
    expect(isClosed()).toBe(true);
    expect(document.activeElement).toBe(trigger());
  });

  it('stays open through a WebKit mouse press, which blurs the search without focusing the format, then takes the click', () => {
    mount();
    const target = formatButtons().find((button) => button.textContent === 'GIF')!;
    const pressed = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(pressed);
      search().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
      search().dispatchEvent(new FocusEvent('blur', { relatedTarget: null }));
    });
    expect(pressed.defaultPrevented).toBe(true);
    expect(isClosed()).toBe(false);
    act(() => target.click());
    expect(onSelect).toHaveBeenCalledWith('gif');
  });
});

const PHONE = { width: 390, height: 844, offsetLeft: 0, offsetTop: 0 };
const rect = (left: number, top: number, width = 112, height = 120) => new DOMRect(left, top, width, height);

describe('where the popover sits', () => {
  it('opens under a tile with room below, 2 px from it, at the reference size', async () => {
    screen.viewport = PHONE;
    screen.trigger = rect(20, 330);
    mount();
    await settled();
    expect(popover()!.style).toMatchObject({ top: '452px', left: '20px', width: '352px', maxHeight: '321px' });
  });

  it('opens above a tile once a keyboard leaves 508 px of the screen, and fits the height above it', async () => {
    screen.viewport = { ...PHONE, height: 508 };
    screen.trigger = rect(20, 330);
    screen.headerBottom = 64;
    mount();
    await settled();
    expect(popover()!.style).toMatchObject({ top: '64px', maxHeight: '264px' });
  });

  it('keeps a trigger the keyboard covers placed against it, instead of closing', async () => {
    screen.viewport = { ...PHONE, height: 508 };
    screen.trigger = rect(20, 700, 128, 44);
    screen.headerBottom = 64;
    mount();
    await settled();
    expect(popover()).not.toBeNull();
    expect(popover()!.style).toMatchObject({ top: '377px', maxHeight: '321px' });
  });

  it('places it against the trigger when the visual viewport is panned down by the keyboard', async () => {
    screen.viewport = { ...PHONE, height: 508, offsetTop: 200 };
    screen.trigger = rect(20, 500, 128, 44);
    screen.headerBottom = 64;
    mount();
    await settled();
    expect(popover()!.style).toMatchObject({ top: '200px', maxHeight: '298px' });
  });

  it('stays inside the 8 px gutter and the width of a narrow screen', async () => {
    screen.viewport = { ...PHONE, width: 320 };
    screen.trigger = rect(300, 330);
    mount();
    await settled();
    expect(popover()!.style).toMatchObject({ left: '8px', width: '304px' });
  });

  it('opens under a trigger below the sticky header, and slides under the header only as its trigger scrolls away', async () => {
    screen.headerBottom = 64;
    screen.trigger = rect(20, 70, 128, 32);
    mount();
    await settled();
    expect(popover()!.style.top).toBe('104px');
    await moveScreen({ trigger: rect(20, -60, 128, 32) });
    expect(popover()!.style.top).toBe('-26px');
    expect(popover()!.contains(document.activeElement)).toBe(true);
  });

  it('moves focus to the trigger, without closing, once the whole popover has scrolled out of view', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    expect(popover()!.contains(document.activeElement)).toBe(true);
    await moveScreen({ trigger: rect(100, -400, 128, 32) });
    expect(popover()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('moves focus once the whole popover is under the sticky header, though it is still inside the screen', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    await moveScreen({ trigger: rect(100, -332, 128, 32) });
    expect(popover()!.style.top).toBe('-298px');
    expect(document.activeElement).toBe(trigger());
  });

  it('keeps focus inside while any of the popover is below the sticky header', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    await moveScreen({ trigger: rect(100, -290, 128, 32) });
    expect(popover()!.style.top).toBe('-256px');
    expect(popover()!.contains(document.activeElement)).toBe(true);
  });

  it('is not taken for gone by a clipping ancestor of its trigger, so opening keeps focus in the search', async () => {
    mountCase({ source: 'png', available: getAvailableTargetFormats('png'), clipped: true });
    await settled();
    expect(popover()!.style.top).toBe('234px');
    expect(document.activeElement).toBe(search());
  });

  it('leaves focus where it is, when it is outside the popover, as the popover scrolls out of view', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    act(() => search().blur());
    expect(document.activeElement).toBe(document.body);
    await moveScreen({ trigger: rect(100, -400, 128, 32) });
    expect(popover()).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('stays open when focus comes back to its trigger', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    await moveScreen({ trigger: rect(100, -400, 128, 32) });
    expect(document.activeElement).toBe(trigger());
    await moveScreen({ trigger: rect(100, -399, 128, 32) });
    expect(popover()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('follows a trigger that changes size and a row above it that grows, as the observers report them', async () => {
    screen.trigger = rect(20, 300);
    mount();
    await settled();
    expect(popover()!.style.top).toBe('422px');
    await changeLayout({ trigger: rect(20, 330) });
    expect(popover()!.style.top).toBe('452px');
    await changeLayout({ trigger: rect(20, 330, 112, 160) });
    expect(popover()!.style.top).toBe('492px');
  });

  it('stops measuring the page once closed, also for a placement still in flight', async () => {
    screen.headerBottom = 64;
    mount();
    await settled();
    act(() => {
      document.defaultView!.dispatchEvent(new Event('scroll'));
    });
    render({ disabled: true });
    const closed = measurements();
    expect(closed.observers).toBe(0);
    await settled();
    await moveScreen({ trigger: rect(100, -400, 128, 32) });
    await changeLayout({ trigger: rect(100, 200, 128, 32) });
    expect(isClosed()).toBe(true);
    expect(measurements()).toEqual(closed);
  });
});

/** Every list a picker can show: all formats on the source tile, each source's targets, and every target at once for "convert all to". */
function pickerLists(): Array<[string, PickerCase]> {
  const all = getAllFormats();
  const union = new Map(all.flatMap((source) => getAvailableTargetFormats(source.id)).map((format) => [format.id, format]));
  return [
    ['every format', {}],
    ['every target of a mixed queue', { available: [...union.values()] }],
    ...all.map((source): [string, PickerCase] => [`the targets of ${source.id}`, { source: source.id, available: getAvailableTargetFormats(source.id) }]),
  ];
}

/** The check mounts the picker for every list in each language (304 lists), which took 8.5 s in Korean on a CI runner. */

describe('the names the picker shows', () => {
  it.each(['en', 'ko'] as const)('are unique within every list it can show, across its categories, to the eye and to a screen reader, in %s', (locale) => {
    const repeated: string[] = [];
    for (const [list, picker] of pickerLists()) {
      mountCase({ ...picker, locale });
      const seen = new Map<string, string>();
      for (const category of categoryButtons()) {
        act(() => category.click());
        for (const button of formatButtons()) {
          for (const name of new Set([button.textContent ?? '', accessibleName(button) ?? ''])) {
            const first = seen.get(name);
            if (first !== undefined && first !== button.dataset.format) repeated.push(`${list}: ${name} (${first}, ${button.dataset.format})`);
            seen.set(name, button.dataset.format!);
          }
        }
      }
      unmount();
    }
    expect(repeated).toEqual([]);
  }, REGISTRY_WIDE_TIMEOUT_MS);
});
