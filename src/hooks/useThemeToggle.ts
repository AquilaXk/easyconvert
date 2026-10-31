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

function writeStoredTheme(theme: string): void {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    void 0;
  }
}

export function useThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const stored = readStoredTheme();
    const hasDarkClass = document.documentElement.classList.contains('dark');
    const next = stored ? stored === 'dark' : hasDarkClass;
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
