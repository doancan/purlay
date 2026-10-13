/**
 * The theme, for components: one store per page, read through a hook.
 *
 * The provider takes its ports as an optional prop and defaults to the browser's,
 * so the application mounts `<ThemeProvider>` bare and a test hands it a fake
 * operating system. The browser's ports are built when the provider first
 * renders, not when this module is imported, because importing must not touch
 * `window` (the build prerenders the shell without one, D-50).
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import {
  createThemeStore,
  type ResolvedTheme,
  type ThemeChoice,
  type ThemePorts,
  type ThemeStore,
} from './theme';

const browserPorts = (): ThemePorts => ({
  storage: window.localStorage,
  query: window.matchMedia('(prefers-color-scheme: dark)'),
  target: document.documentElement,
});

const ThemeContext = createContext<ThemeStore | null>(null);

interface ThemeProviderProps {
  readonly ports?: ThemePorts;
  readonly children: React.ReactNode;
}

export const ThemeProvider = ({ ports, children }: ThemeProviderProps): React.JSX.Element => {
  // A lazy initialiser: the store is created once per mount of the provider. What it listens to
  // is started by the effect and stopped by the effect's cleanup, so a cleanup that React follows
  // with the effect again (StrictMode, a kept state brought back) leaves it listening.
  const [themeStore] = useState(() => createThemeStore(ports ?? browserPorts()));
  useEffect(() => themeStore.connect(), [themeStore]);
  return <ThemeContext value={themeStore}>{children}</ThemeContext>;
};

export interface UseTheme {
  readonly choice: ThemeChoice;
  /** What is actually showing: `system` resolved to the operating system's answer. */
  readonly resolved: ResolvedTheme;
  readonly setChoice: (choice: ThemeChoice) => void;
}

export const useTheme = (): UseTheme => {
  const themeStore = useContext(ThemeContext);
  if (themeStore === null) throw new Error('useTheme needs a <ThemeProvider> above it');
  const choice = useStore(themeStore.store, (state) => state.choice);
  const resolved = useStore(themeStore.store, (state) => state.resolved);
  const setChoice = useStore(themeStore.store, (state) => state.setChoice);
  return { choice, resolved, setChoice };
};
