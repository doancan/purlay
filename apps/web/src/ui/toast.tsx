/**
 * A short message that leaves by itself, with an optional way to take the action
 * back — "Pasted text became a code block · Undo" (`UX.md` §5).
 *
 * **A toast is a live region, and the region exists before any toast does.**
 * Screen readers announce changes to a live region they already know about;
 * inserting a region and its content together is announced by some and not by
 * others. So `<Toaster />` mounts once, empty, `role="status"`, and toasts arrive
 * inside it.
 *
 * **It waits while it is being read or used.** The timer stops while the pointer
 * is over a toast or focus is in it, and starts again from the full duration when
 * both leave: an action that disappears as the cursor reaches it is worse than no
 * action. Escape dismisses the toast that has focus.
 *
 * No library: this is a list in a store, a timer per entry and a region. The timer
 * is an argument (`Schedule`, the realtime client's own type) so a test advances
 * time by calling a function, and the store is created by the provider, not at
 * import, so the build can prerender without a clock.
 */
import { createContext, useContext, useState } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Schedule } from '../realtime/connection';
import { browserSchedule } from '../realtime/socket';
import { Button } from './button';
import { IconButton } from './icon-button';

/** Long enough to read a sentence and reach for Undo; short enough not to pile up. */
export const TOAST_DURATION_MS = 6_000;

interface ToastInput {
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly durationMs?: number;
}

interface Toast {
  readonly id: number;
  readonly message: string;
  readonly action: { readonly label: string; readonly run: () => void } | null;
  readonly durationMs: number;
}

export interface ToastState {
  readonly toasts: readonly Toast[];
  readonly show: (input: ToastInput) => number;
  readonly dismiss: (id: number) => void;
  /** Stops the clock on a toast being read; `resume` starts it again from the full duration. */
  readonly pause: (id: number) => void;
  readonly resume: (id: number) => void;
}

export const createToastStore = (schedule: Schedule): StoreApi<ToastState> => {
  let next = 1;
  const timers = new Map<number, () => void>();

  const store = createStore<ToastState>()((set, get) => {
    const stop = (id: number): void => {
      timers.get(id)?.();
      timers.delete(id);
    };
    const start = (id: number): void => {
      stop(id);
      const toast = get().toasts.find((candidate) => candidate.id === id);
      if (toast === undefined) return;
      timers.set(
        id,
        schedule(() => {
          get().dismiss(id);
        }, toast.durationMs),
      );
    };
    return {
      toasts: [],
      show: (input): number => {
        const id = next++;
        const action =
          input.actionLabel === undefined || input.onAction === undefined
            ? null
            : { label: input.actionLabel, run: input.onAction };
        set((state) => ({
          toasts: [
            ...state.toasts,
            {
              id,
              message: input.message,
              action,
              durationMs: input.durationMs ?? TOAST_DURATION_MS,
            },
          ],
        }));
        start(id);
        return id;
      },
      dismiss: (id): void => {
        stop(id);
        set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
      },
      pause: stop,
      resume: start,
    };
  });
  return store;
};

const ToastContext = createContext<StoreApi<ToastState> | null>(null);

interface ToastProviderProps {
  readonly schedule?: Schedule;
  readonly children: React.ReactNode;
}

export const ToastProvider = ({ schedule, children }: ToastProviderProps): React.JSX.Element => {
  const [store] = useState(() => createToastStore(schedule ?? browserSchedule));
  return <ToastContext value={store}>{children}</ToastContext>;
};

const useToastStore = (): StoreApi<ToastState> => {
  const store = useContext(ToastContext);
  if (store === null) throw new Error('toasts need a <ToastProvider> above them');
  return store;
};

export interface UseToast {
  readonly show: (input: ToastInput) => number;
  readonly dismiss: (id: number) => void;
}

export const useToast = (): UseToast => {
  const store = useToastStore();
  const show = useStore(store, (state) => state.show);
  const dismiss = useStore(store, (state) => state.dismiss);
  return { show, dismiss };
};

const toastClasses =
  'pointer-events-auto flex max-w-toast items-center gap-3 rounded-lg border-hairline border-border-subtle bg-surface-100 py-2 pl-3 pr-2 text-body text-ink shadow-float';

interface ToasterProps {
  /** The dismiss button's name, in the interface's language. */
  readonly dismissLabel: string;
}

export const Toaster = ({ dismissLabel }: ToasterProps): React.JSX.Element => {
  const store = useToastStore();
  const toasts = useStore(store, (state) => state.toasts);
  const { dismiss, pause, resume } = store.getState();
  return (
    <div
      role="status"
      className="pointer-events-none fixed bottom-4 left-4 z-toast flex flex-col items-start gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={toastClasses}
          onPointerEnter={() => {
            pause(toast.id);
          }}
          onPointerLeave={() => {
            resume(toast.id);
          }}
          onFocus={() => {
            pause(toast.id);
          }}
          onBlur={() => {
            resume(toast.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') dismiss(toast.id);
          }}
        >
          <span>{toast.message}</span>
          {toast.action === null ? null : (
            <Button
              variant="ghost"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </Button>
          )}
          <IconButton
            label={dismissLabel}
            glyph="close"
            onClick={() => {
              dismiss(toast.id);
            }}
          />
        </div>
      ))}
    </div>
  );
};
