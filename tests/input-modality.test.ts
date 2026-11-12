// @vitest-environment jsdom
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INPUT_MODALITY_SCRIPT } from '@/lib/input-modality';

const root = document.documentElement;
const modality = () => root.getAttribute('data-input-modality');
const key = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
const press = () => document.dispatchEvent(new Event('pointerdown', { bubbles: true }));

describe('the input modality behind the focus ring', () => {
  beforeAll(() => {
    // The same text the layout puts in the document head.
    new Function(INPUT_MODALITY_SCRIPT)();
  });

  beforeEach(() => root.removeAttribute('data-input-modality'));

  it('says nothing before any input, so the ring keeps its default', () => {
    expect(modality()).toBeNull();
  });

  it('turns to pointer on a press and back to keyboard on Tab', () => {
    press();
    expect(modality()).toBe('pointer');
    key({ key: 'Tab' });
    expect(modality()).toBe('keyboard');
  });

  it('keeps pointer for modifier keys and shortcuts, which also arrive when a person returns to the tab', () => {
    press();
    for (const init of [{ key: 'Shift' }, { key: 'Control' }, { key: 'Meta' }, { key: 'c', ctrlKey: true }, { key: 'r', metaKey: true }]) {
      key(init);
      expect(modality()).toBe('pointer');
    }
  });

  it('hides the ring only under pointer, more specifically than the dark theme colour', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8');
    expect(css).toMatch(/:root\[data-input-modality='pointer'\] :focus-visible \{\s*outline-color: transparent;/);
  });

  it('runs from the document head of every page', () => {
    const layout = fs.readFileSync(path.join(process.cwd(), 'src/app/[locale]/layout.tsx'), 'utf8');
    const head = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'));
    expect(head.match(/__html: INPUT_MODALITY_SCRIPT/g)).toHaveLength(1);
  });
});
