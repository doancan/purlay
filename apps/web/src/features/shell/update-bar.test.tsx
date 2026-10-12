/**
 * The bar that offers a reload when this tab's build has gone (#334): nothing until a chunk fails,
 * then a status with Reload, and the failure is not swallowed.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { STALE_BUILD_EVENT, UpdateBar } from './update-bar';

installDom();

const chunkFailed = (target: EventTarget): Event => {
  const event = new Event(STALE_BUILD_EVENT, { cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

describe('the update bar', () => {
  test('is nothing until a chunk fails; then it says so and Reload reloads', async () => {
    const target = new EventTarget();
    let reloads = 0;
    const view = await renderApp(
      <UpdateBar
        target={target}
        reload={() => {
          reloads += 1;
        }}
      />,
    );
    expect(view.queryByRole('status')).toBeNull();
    const event = chunkFailed(target);
    // Not cancelled: the code that asked for the chunk still sees it fail.
    expect(event.defaultPrevented).toBe(false);
    expect(view.getByRole('status').textContent).toContain('Purlay was updated');
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: 'Reload' }));
    expect(reloads).toBe(1);
    view.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const target = new EventTarget();
    const view = await renderApp(<UpdateBar target={target} reload={() => undefined} />, {
      locale: 'tr',
    });
    chunkFailed(target);
    expect(view.getByRole('button', { name: 'Yenile' })).toBeDefined();
    view.unmount();
  });

  test('by default listens on the window and reloads the page', async () => {
    const reload = spyOn(window.location, 'reload').mockImplementation(() => undefined);
    const view = await renderApp(<UpdateBar />);
    chunkFailed(window);
    await person().click(view.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
    view.unmount();
  });

  test('stops listening when it goes', async () => {
    const target = new EventTarget();
    let listening = 0;
    const counting: EventTarget = {
      addEventListener: (...args: Parameters<EventTarget['addEventListener']>) => {
        listening += 1;
        target.addEventListener(...args);
      },
      removeEventListener: (...args: Parameters<EventTarget['removeEventListener']>) => {
        listening -= 1;
        target.removeEventListener(...args);
      },
      dispatchEvent: (event) => target.dispatchEvent(event),
    };
    const view = await renderApp(<UpdateBar target={counting} reload={() => undefined} />);
    expect(listening).toBe(1);
    view.unmount();
    expect(listening).toBe(0);
  });
});
