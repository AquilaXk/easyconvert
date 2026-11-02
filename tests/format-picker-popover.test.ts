// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { computePopoverPosition } from '../src/components/FormatSelector';
import FormatPickerButton from '../src/components/workbench/FormatPickerButton';
import { getAllFormats, getAvailableTargetFormats } from '../src/lib/registry';
import type { FormatDefinition } from '../src/lib/types';
import { testMessages } from './helpers/intl-messages';

/**
 * The format picker as a person drives it: a popover under its trigger with a search field, a category column and a grid
 * of formats. Each format appears once under its own name, the current one is marked, the keyboard moves through the grid,
 * and a mouse press in WebKit (which blurs the search without focusing what was pressed) does not close it.
 */

let root: Root | undefined;
let onSelect: Mock<(formatId: string) => void>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom lays nothing out; the popover opens only under a trigger that is on screen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 128, 32));
  onSelect = vi.fn<(formatId: string) => void>();
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface PickerCase {
  selected?: string;
  /** The source whose targets the picker lists; none lists every format, as the source tile does. */
  source?: string;
  available?: FormatDefinition[];
}

/** A trigger as the pages draw one; `mountCase` presses it. */
function Harness({ selected, source, available }: Readonly<PickerCase>) {
  return createElement(FormatPickerButton, {
    testId: 'trigger', className: '', sourceFormat: source, availableFormats: available, selectedFormatId: selected, onSelect,
    children: 'JPG',
  });
}

function mountCase(picker: PickerCase) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(NextIntlClientProvider, {
        locale: 'en', messages: testMessages('en'), timeZone: 'UTC',
        children: createElement(Harness, picker),
      })
    )
  );
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
    expect(current[0].title).toBe('ULTRAHDR');
    expect(new Set(formatButtons().map(accessibleName)).size).toBe(formatButtons().length);
  });

  it('stays open and follows its trigger when the page scrolls, keeping focus inside, as the reference popover does', () => {
    mount();
    const before = popover()!.style.top;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect(100, -400, 128, 32));
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(popover()).not.toBeNull();
    expect(popover()!.style.top).not.toBe(before);
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

/** The phone of the review: a 390 by 844 layout viewport under a 64 px sticky header. */
const LAYOUT_HEIGHT = 844;
const rect = (left: number, top: number, width: number, height: number) => new DOMRect(left, top, width, height);
const visible = (top: number, bottom: number) => ({ left: 0, top, right: 390, bottom });

describe('where the popover sits', () => {
  it('opens under a tile with room below while no keyboard is up', () => {
    expect(computePopoverPosition(rect(20, 330, 112, 120), visible(64, 844), LAYOUT_HEIGHT)).toMatchObject({ top: 452, bottom: 'auto', maxHeight: 321 });
  });

  it('opens above a tile in layout coordinates once a keyboard leaves 508 px of the screen, and fits the height above it', () => {
    const style = computePopoverPosition(rect(20, 330, 112, 120), visible(64, 508), LAYOUT_HEIGHT);
    expect(style).toMatchObject({ top: 'auto', bottom: LAYOUT_HEIGHT - 330 + 2, maxHeight: 330 - 2 - 64 });
  });

  it('keeps a trigger the keyboard covers placed, instead of closing', () => {
    const style = computePopoverPosition(rect(20, 700, 128, 44), visible(64, 508), LAYOUT_HEIGHT);
    expect(style).toMatchObject({ top: 'auto', bottom: LAYOUT_HEIGHT - 700 + 2, maxHeight: 321 });
  });

  it('measures the room from the top of a visual viewport scrolled down by the keyboard', () => {
    const style = computePopoverPosition(rect(20, 500, 128, 44), visible(200, 708), LAYOUT_HEIGHT);
    expect(style).toMatchObject({ top: 'auto', bottom: LAYOUT_HEIGHT - 500 + 2, maxHeight: 500 - 2 - 200 });
  });

  it('stays inside the 8 px gutter and the width of a narrow screen', () => {
    const style = computePopoverPosition(rect(300, 330, 112, 120), { left: 0, top: 64, right: 320, bottom: 700 }, 700);
    expect(style).toMatchObject({ left: 8, width: 304 });
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

describe('the names the picker shows', () => {
  it('are unique within every list it can show, across its categories, to the eye and to a screen reader', () => {
    const repeated: string[] = [];
    for (const [list, picker] of pickerLists()) {
      mountCase(picker);
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
  });
});
