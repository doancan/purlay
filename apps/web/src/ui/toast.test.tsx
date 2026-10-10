/**
 * Toasts: arriving, leaving by themselves, waiting while they are read, and the
 * action that takes the thing back. Time is the fake schedule's, so "six seconds
 * later" is one function call.
 */
import { installDom } from '../testing/dom';
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { fakeSchedule } from '../testing/fakes';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { Button } from './button';
import { TooltipProvider } from './tooltip';
import { TOAST_DURATION_MS, Toaster, ToastProvider, createToastStore, useToast } from './toast';

installDom();

const Page = ({
  onUndo,
  durationMs,
}: {
  readonly onUndo?: () => void;
  readonly durationMs?: number;
}): React.JSX.Element => {
  const { show } = useToast();
  return (
    <div>
      <Button
        onClick={() => {
          show({
            message: 'Pasted text became a code block',
            ...(onUndo === undefined ? {} : { actionLabel: 'Undo', onAction: onUndo }),
            ...(durationMs === undefined ? {} : { durationMs }),
          });
        }}
      >
        paste
      </Button>
      <Toaster dismissLabel="Dismiss" />
    </div>
  );
};

describe('the live region', () => {
  test('exists before any toast does, so the first one is announced', async () => {
    const { getByRole } = await renderApp(<Page />);
    expect(getByRole('status').textContent).toBe('');
  });
});

describe('a toast', () => {
  test('appears in the live region', async () => {
    const { getByRole } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    expect(getByRole('status').textContent).toContain('Pasted text became a code block');
  });

  test('leaves by itself after its duration, and not before', async () => {
    const { getByRole, world } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    act(() => {
      world.timers.advance(TOAST_DURATION_MS - 1);
    });
    expect(getByRole('status').textContent).toContain('Pasted');
    act(() => {
      world.timers.advance(1);
    });
    expect(getByRole('status').textContent).toBe('');
  });

  test('a toast can ask for longer', async () => {
    const { getByRole, world } = await renderApp(<Page durationMs={20_000} />);
    await person().click(getByRole('button', { name: 'paste' }));
    act(() => {
      world.timers.advance(TOAST_DURATION_MS);
    });
    expect(getByRole('status').textContent).toContain('Pasted');
    act(() => {
      world.timers.advance(20_000);
    });
    expect(getByRole('status').textContent).toBe('');
  });

  test('waits while it is being read, then starts again from the full duration', async () => {
    const { getByRole, world, getByText } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    const toast = getByText('Pasted text became a code block').parentElement;
    if (toast === null) throw new Error('the toast has a container');
    fireEvent.pointerEnter(toast);
    expect(world.timers.pending()).toBe(0);
    act(() => {
      world.timers.advance(TOAST_DURATION_MS * 3);
    });
    expect(getByRole('status').textContent).toContain('Pasted');
    fireEvent.pointerLeave(toast);
    expect(world.timers.pending()).toBe(1);
    act(() => {
      world.timers.advance(TOAST_DURATION_MS);
    });
    expect(getByRole('status').textContent).toBe('');
  });

  test('waits while it has focus, too', async () => {
    const { getByRole, world } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    act(() => {
      getByRole('button', { name: 'Dismiss' }).focus();
    });
    expect(world.timers.pending()).toBe(0);
    act(() => {
      getByRole('button', { name: 'Dismiss' }).blur();
    });
    expect(world.timers.pending()).toBe(1);
  });

  test('its action runs and takes the toast with it', async () => {
    const onUndo = mock(() => undefined);
    const { getByRole } = await renderApp(<Page onUndo={onUndo} />);
    await person().click(getByRole('button', { name: 'paste' }));
    await person().click(getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(getByRole('status').textContent).toBe('');
  });

  test('dismisses with its button, and with Escape from inside it', async () => {
    const { getByRole } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    await person().click(getByRole('button', { name: 'Dismiss' }));
    expect(getByRole('status').textContent).toBe('');
    await person().click(getByRole('button', { name: 'paste' }));
    act(() => {
      getByRole('button', { name: 'Dismiss' }).focus();
    });
    await person().keyboard('{Escape}');
    expect(getByRole('status').textContent).toBe('');
  });

  test('another key does not dismiss it', async () => {
    const { getByRole } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    act(() => {
      getByRole('button', { name: 'Dismiss' }).focus();
    });
    await person().keyboard('{Shift}');
    expect(getByRole('status').textContent).toContain('Pasted');
  });

  test('several stack in the order they came', async () => {
    const { getByRole } = await renderApp(<Page />);
    await person().click(getByRole('button', { name: 'paste' }));
    await person().click(getByRole('button', { name: 'paste' }));
    expect(getByRole('status').children).toHaveLength(2);
  });

  test('passes the accessibility audit, with an action', async () => {
    const { getByRole, container } = await renderApp(<Page onUndo={() => undefined} />);
    await person().click(getByRole('button', { name: 'paste' }));
    await expectNoAxeViolations(container);
  });
});

describe('the store', () => {
  test('hands out ids that are never reused', () => {
    const { schedule } = fakeSchedule();
    const store = createToastStore(schedule);
    const first = store.getState().show({ message: 'a' });
    store.getState().dismiss(first);
    expect(store.getState().show({ message: 'b' })).toBeGreaterThan(first);
  });

  test('dismissing a toast that is already gone does nothing', () => {
    const { schedule } = fakeSchedule();
    const store = createToastStore(schedule);
    store.getState().dismiss(99);
    expect(store.getState().toasts).toEqual([]);
  });

  test('resuming a toast that is gone starts no timer', () => {
    const fake = fakeSchedule();
    const store = createToastStore(fake.schedule);
    store.getState().resume(7);
    expect(fake.pending()).toBe(0);
  });

  test('an action needs both a label and a handler, or it is not offered', () => {
    const { schedule } = fakeSchedule();
    const store = createToastStore(schedule);
    store.getState().show({ message: 'a', actionLabel: 'Undo' });
    store.getState().show({ message: 'b', onAction: () => undefined });
    expect(store.getState().toasts.map((toast) => toast.action)).toEqual([null, null]);
  });
});

describe('the hooks', () => {
  test('refuse to work without a provider', () => {
    // React reports the error it throws; the test asserts the throw.
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Page />)).toThrow('<ToastProvider>');
    } finally {
      logged.mockRestore();
    }
  });

  test('the provider uses the browser’s timers when given none', async () => {
    const { getByRole } = render(
      <TooltipProvider>
        <ToastProvider>
          <Page />
        </ToastProvider>
      </TooltipProvider>,
    );
    await person().click(getByRole('button', { name: 'paste' }));
    expect(getByRole('status').textContent).toContain('Pasted');
  });
});
