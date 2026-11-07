/** Order personal navigation writes in one client; only the last asks for authoritative state. */
import type { QueryClient } from '@tanstack/react-query';

const lines = new WeakMap<QueryClient, Map<string, Promise<void>>>();

export const sidebarWrite = <T>(
  client: QueryClient,
  key: string,
  write: () => Promise<T>,
  idle: () => void,
): Promise<T> => {
  const held = lines.get(client) ?? new Map<string, Promise<void>>();
  lines.set(client, held);
  const result = (held.get(key) ?? Promise.resolve()).then(write);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  held.set(key, settled);
  void settled.then(() => {
    if (held.get(key) !== settled) return;
    held.delete(key);
    idle();
  });
  return result;
};

export interface SidebarIntent<State, Answer> {
  readonly client: QueryClient;
  readonly key: string;
  readonly queueKey: string;
  readonly read: () => State;
  readonly paint: (value: State) => void;
  readonly apply: (value: State) => State;
  readonly write: () => Promise<Answer>;
  readonly accepted: (value: State, answer: Answer) => State;
  readonly refresh: () => void;
}

interface Ledger<State> {
  readonly base: State;
  readonly pending: readonly { readonly apply: (value: State) => State }[];
}

/** Repaint pending intentions over the last confirmed state, never over another failed intention. */
export const sidebarLedger = <State>(): {
  readonly send: <Answer>(intent: SidebarIntent<State, Answer>) => Promise<Answer>;
} => {
  const clients = new WeakMap<QueryClient, Map<string, Ledger<State>>>();
  return {
    send: async <Answer>(intent: SidebarIntent<State, Answer>): Promise<Answer> => {
      const { client, key, queueKey, apply, paint, read, write, accepted, refresh } = intent;
      const held = clients.get(client) ?? new Map<string, Ledger<State>>();
      clients.set(client, held);
      const before = held.get(key) ?? { base: read(), pending: [] };
      const operation = { apply };
      const next = { base: before.base, pending: [...before.pending, operation] };
      held.set(key, next);
      paint(next.pending.reduce((value, pending) => pending.apply(value), next.base));
      const finish = (answer: { readonly value: Answer } | null): void => {
        const current = held.get(key);
        if (current === undefined) return;
        const base = answer === null ? current.base : accepted(current.base, answer.value);
        const pending = current.pending.filter((entry) => entry !== operation);
        if (pending.length === 0) held.delete(key);
        else held.set(key, { base, pending });
        paint(pending.reduce((value, pending) => pending.apply(value), base));
      };
      try {
        const answer = await sidebarWrite(client, queueKey, write, refresh);
        finish({ value: answer });
        return answer;
      } catch (failure) {
        finish(null);
        throw failure;
      }
    },
  };
};
