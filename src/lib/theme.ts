import { useCallback, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light';

const KEY = 'zm-theme';

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light';
}

if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = readTheme();
}

/** One shared store so every useTheme() caller re-renders on a flip. */
const listeners = new Set<(t: Theme) => void>();

/** Theme lives on <html data-theme>, so CSS and MapLibre can both read it. */
export function applyTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  localStorage.setItem(KEY, next);
  listeners.forEach((fn) => fn(next));
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    listeners.add(setTheme);
    return () => void listeners.delete(setTheme);
  }, []);

  const toggle = useCallback(() => {
    applyTheme(readTheme() === 'dark' ? 'light' : 'dark');
  }, []);

  return { theme, toggle };
}
