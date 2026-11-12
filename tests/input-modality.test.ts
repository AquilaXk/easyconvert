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

  it('draws the ring and its halo only outside pointer modality, in both themes', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]*:focus-visible)\s*\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
    const drawing = rules.filter((rule) => /outline: 1px solid|box-shadow/.test(rule.body));
    expect(drawing.map((rule) => rule.selector)).toEqual([
      ":root:not([data-input-modality='pointer']) :focus-visible",
      ":root.dark:not([data-input-modality='pointer']) :focus-visible",
      ":root:not([data-input-modality='pointer']) .focus-inset:focus-visible",
      ":root.dark:not([data-input-modality='pointer']) .focus-inset:focus-visible",
    ]);
    expect(rules.find((rule) => rule.selector === ':focus-visible')?.body).toMatch(/outline: none;/);
  });

  it('runs from the document head of every page', () => {
    const layout = fs.readFileSync(path.join(process.cwd(), 'src/app/[locale]/layout.tsx'), 'utf8');
    const head = layout.slice(layout.indexOf('<head>'), layout.indexOf('</head>'));
    expect(head.match(/__html: INPUT_MODALITY_SCRIPT/g)).toHaveLength(1);
  });
});
