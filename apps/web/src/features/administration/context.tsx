import { createContext, useContext } from 'react';
import { createAdministrationClient } from './client';

type AdministrationClient = ReturnType<typeof createAdministrationClient>;
const Context = createContext<AdministrationClient | null>(null);
export const AdministrationClientProvider = Context.Provider;
const platform = createAdministrationClient(async (input, init) => await fetch(input, init));
export const useAdministrationClient = (): AdministrationClient => useContext(Context) ?? platform;
