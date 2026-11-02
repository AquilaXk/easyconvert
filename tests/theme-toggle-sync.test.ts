// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useThemeToggle } from '../src/hooks/useThemeToggle';

/** Two theme toggles on one page, as the header and its mobile menu hold: pressing one turns the page dark and the other follows. */

let root: Root | undefined;
afterEach(() => {
  root?.unmount();
  root = undefined;
  document.body.innerHTML = '';
  document.documentElement.classList.remove('dark');
});

function Toggle({ name }: Readonly<{ name: string }>) {
  const { isDark, toggleDarkMode } = useThemeToggle();
  return createElement('button', { type: 'button', 'data-name': name, 'aria-pressed': isDark, onClick: toggleDarkMode }, name);
}

describe('the theme toggles of a page', () => {
  it('turn the page dark together and remember the choice', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    root.render(createElement('div', null, createElement(Toggle, { name: 'header' }), createElement(Toggle, { name: 'menu' })));
    await vi.waitFor(() => expect(host.querySelectorAll('button')).toHaveLength(2));
    const [header, menu] = host.querySelectorAll('button');

    header.click();
    await vi.waitFor(() => expect(menu.getAttribute('aria-pressed')).toBe('true'));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('theme')).toBe('dark');
  });
});
