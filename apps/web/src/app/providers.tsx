/**
 * Everything a screen can ask for from above it, mounted once, in one order.
 *
 * The order is the dependency order: the theme and the words come first because
 * nothing renders without them (and the words are the one that makes the rest
 * wait, so it takes the `fallback`); the router and the cache next; the tooltip
 * timing and the toast list last, because they are leaves.
 *
 * Every provider takes its outside world as an optional port, so the browser's
 * are the defaults and a test passes fakes for the ones it cares about — one
 * component, two worlds. The component tests and the application mount the same
 * tree; a provider missing from a test is a provider missing from the app.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { I18nPorts } from '../i18n/i18n-provider';
import { I18nProvider } from '../i18n/i18n-provider';
import type { Schedule } from '../realtime/connection';
import type { HistoryPort } from '../router/router';
import { RouterProvider } from '../router/router-provider';
import type { ThemePorts } from '../theme/theme';
import { ThemeProvider } from '../theme/theme-provider';
import { TooltipProvider } from '../ui/tooltip';
import { ToastProvider } from '../ui/toast';
import { createQueryClient } from './query-client';

export interface AppPorts {
  readonly theme?: ThemePorts;
  readonly i18n?: I18nPorts;
  readonly history?: HistoryPort;
  readonly schedule?: Schedule;
  readonly queryClient?: QueryClient;
}

interface AppProvidersProps {
  readonly ports?: AppPorts;
  /** Shown until the first catalogue has loaded: the prerendered shell's skeleton. */
  readonly fallback?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const AppProviders = ({
  ports = {},
  fallback,
  children,
}: AppProvidersProps): React.JSX.Element => {
  // One cache for the life of the page; a re-render must never replace it.
  const [client] = useState(() => ports.queryClient ?? createQueryClient());
  return (
    <ThemeProvider {...(ports.theme === undefined ? {} : { ports: ports.theme })}>
      <I18nProvider
        {...(ports.i18n === undefined ? {} : { ports: ports.i18n })}
        {...(fallback === undefined ? {} : { fallback })}
      >
        <RouterProvider {...(ports.history === undefined ? {} : { history: ports.history })}>
          <QueryClientProvider client={client}>
            <TooltipProvider>
              <ToastProvider
                {...(ports.schedule === undefined ? {} : { schedule: ports.schedule })}
              >
                {children}
              </ToastProvider>
            </TooltipProvider>
          </QueryClientProvider>
        </RouterProvider>
      </I18nProvider>
    </ThemeProvider>
  );
};
