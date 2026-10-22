/**
 * The client Administration → Server's cards call through, and the one query they read: provided so a
 * test answers with its own, and the page asks the platform's `fetch` otherwise.
 */
import { createContext, useContext } from 'react';
import { createServerClient, type CreatorsChoice, type ServerClient } from './server-client';

export type { CreatorsChoice };

const ServerClientContext = createContext<ServerClient | null>(null);

export const ServerClientProvider = ServerClientContext.Provider;

const platform = createServerClient(async (input, init) => await fetch(input, init));

export const useServerClient = (): ServerClient => useContext(ServerClientContext) ?? platform;

/** The page's one query: read again after any change, never polled. */
export const SERVER_SETTINGS_KEY = ['server', 'settings'] as const;
