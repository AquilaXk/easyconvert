'use client';

import { useCallback, useEffect, useState } from 'react';

interface ThemeEventDetail {
  theme?: string;
}

function readStoredTheme(): string | null {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function writeStoredTheme(theme: string): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    void 0;
  }
}

export function themeFor(stored: string | null, systemDark: boolean): boolean {
  return stored ? stored === 'dark' : systemDark;
}

export function useThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const next = themeFor(readStoredTheme(), systemPrefersDark());
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);

    const handleThemeChange: EventListener = (event) => {
      const custom = event as CustomEvent<ThemeEventDetail>;
      if (custom.detail?.theme) {
        const nextDark = custom.detail.theme === 'dark';
        setIsDark(nextDark);
        document.documentElement.classList.toggle('dark', nextDark);
      }
    };

    window.addEventListener('easyconvert-theme-change', handleThemeChange);
    return () => {
      window.removeEventListener('easyconvert-theme-change', handleThemeChange);
    };
  }, []);

  const toggleDarkMode = useCallback(() => {
    const nextTheme = isDark ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
    writeStoredTheme(nextTheme);
    setIsDark(nextTheme === 'dark');
    window.dispatchEvent(
      new CustomEvent('easyconvert-theme-change', { detail: { theme: nextTheme } })
    );
  }, [isDark]);

  return { isDark, toggleDarkMode };
}
