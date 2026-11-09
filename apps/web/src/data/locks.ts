/** Native cross-tab coordination, shared by browser and DOM tests. */
import { createContext, useContext } from 'react';

export const LocksContext = createContext<LockManager | null | undefined>(undefined);

export const useLocks = (): LockManager | null => {
  const supplied = useContext(LocksContext);
  return supplied === undefined
    ? typeof navigator !== 'undefined' && 'locks' in navigator
      ? navigator.locks
      : null
    : supplied;
};
