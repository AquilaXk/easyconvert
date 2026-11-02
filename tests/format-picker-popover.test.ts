// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FormatSelector from '../src/components/FormatSelector';
import { getAvailableTargetFormats } from '../src/lib/registry';
import { testMessages } from './helpers/intl-messages';

/**
 * The format picker as a person drives it: a popover under its trigger with a search field, a category column and a grid
 * of formats. Each format appears once under its own name, the current one is marked, the keyboard moves through the grid,
 * and a mouse press in WebKit (which blurs the search without focusing what was pressed) does not close it.
 */

let root: Root | undefined;
let onSelect: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom lays nothing out; the popover opens only under a trigger that is on screen.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 200, 128, 32));
  onSelect = vi.fn();
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Harness({ selected }: Readonly<{ selected: string }>) {
  const [open, setOpen] = useState(true);
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', id: 'trigger', onClick: () => setOpen(true) }, 'JPG'),
    open &&
      createElement(FormatSelector, {
        sourceFormat: 'png',
        availableFormats: getAvailableTargetFormats('png'),
        selectedFormatId: selected,
        onSelect,
        onClose: () => {
          onClose();
          setOpen(false);
        },
      })
  );
}

function mount(selected = 'jpg') {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(NextIntlClientProvider, {
        locale: 'en', messages: testMessages('en'), timeZone: 'UTC',
        children: createElement(Harness, { selected }),
      })
    )
  );
}

const popover = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const search = () => popover()!.querySelector<HTMLInputElement>('input[type=text]')!;
const formatButtons = () => [...popover()!.querySelectorAll<HTMLButtonElement>('[data-format]')];
const formatNames = () => formatButtons().map((button) => button.textContent);
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
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(popover()).toBeNull();
    expect(document.activeElement?.id).toBe('trigger');
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
    expect(onClose).not.toHaveBeenCalled();
    expect(popover()).not.toBeNull();
    act(() => target.click());
    expect(onSelect).toHaveBeenCalledWith('gif');
  });
});
