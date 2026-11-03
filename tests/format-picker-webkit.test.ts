// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FormatPickerButton from '../src/components/workbench/FormatPickerButton';
import { testMessages } from './helpers/intl-messages';
import { layOutPage, restorePage, screen, settled } from './helpers/picker-screen';

/**
 * The format picker in WebKit, where iOS pans the visual viewport to reveal the focused search field and a rect read from
 * the page lies in the visual viewport's frame while a fixed element is placed in the layout viewport's. The engine is told
 * it is WebKit by the one feature test it uses, which it reads once per page, so this runs in a file of its own.
 */

let root: Root | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('CSS', { supports: (property: string) => property === '-webkit-backdrop-filter' });
  layOutPage();
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  restorePage();
});

function openPicker() {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(NextIntlClientProvider, {
        locale: 'en', messages: testMessages('en'), timeZone: 'UTC',
        children: createElement('div', null,
          createElement('header', { 'data-sticky-header': '' }),
          createElement(FormatPickerButton, { testId: 'trigger', className: '', onSelect: vi.fn(), children: 'JPG' })),
      })
    )
  );
  act(() => document.querySelector<HTMLButtonElement>('[data-testid=trigger]')!.click());
}

describe('where the popover sits in WebKit', () => {
  it('places it against a trigger read in the visual viewport once that viewport is panned down by the keyboard', async () => {
    screen.viewport = { width: 390, height: 508, offsetLeft: 0, offsetTop: 200 };
    screen.trigger = new DOMRect(20, 300, 128, 44);
    openPicker();
    await settled();
    expect(document.querySelector<HTMLDialogElement>('dialog[open]')!.style).toMatchObject({ top: '200px', maxHeight: '298px' });
  });

  it('keeps clear of a sticky header that is still in view inside the panned viewport', async () => {
    screen.viewport = { width: 390, height: 508, offsetLeft: 0, offsetTop: 200 };
    screen.trigger = new DOMRect(20, 300, 128, 44);
    screen.headerBottom = 64;
    openPicker();
    await settled();
    expect(document.querySelector<HTMLDialogElement>('dialog[open]')!.style).toMatchObject({ top: '264px', maxHeight: '234px' });
  });
});
