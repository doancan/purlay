/**
 * What the wizard does around its steps: the chunk door of the address link's page, a status or a state
 * that could not be read and is asked for again, a value to copy when the clipboard refuses, the
 * test client's refusal of a call nobody expected, and the motion hook where there is no window.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SetupFailure } from './client';
import { useReducedMotion } from './motion';
import { CopyField } from './parts';
import { aClient, aState, openSetup, ORIGIN, settle } from './testing';
import { VerifyScreen } from './verify-screen';

installDom();

const TOKEN = 'b2'.repeat(32);

describe('the address link, opened through the front door', () => {
  let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
  beforeEach(() => {
    network = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"verified":true}'));
  });
  afterEach(() => {
    network.mockRestore();
    window.history.replaceState(null, '', '/');
  });

  test('loads the page on demand, posts the token it carries once, and says it is verified', async () => {
    window.history.replaceState(null, '', `/setup/verify#${TOKEN}`);
    const view = await renderApp(<Outlet />, {
      path: '/setup/verify',
      api: anApi({ me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')) }),
    });
    expect(
      await view.findByRole('heading', { name: 'Your address is verified' }, { timeout: 3000 }),
    ).toBeDefined();
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]?.[0]).toBe('/setup/verify');
    expect(network.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ token: TOKEN }));
  });
});

describe('the address link, asked again', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  test('Retry posts the token again and shows the answer', async () => {
    window.history.replaceState(null, '', `/setup/verify#${TOKEN}`);
    const posted: string[] = [];
    const view = await renderApp(
      <VerifyScreen
        client={aClient({
          verify: (token) => {
            posted.push(token);
            return posted.length === 1
              ? Promise.reject(new SetupFailure(0, 'NETWORK', 'down'))
              : Promise.resolve({ verified: true });
          },
        })}
      />,
      { path: '/setup/verify' },
    );
    await settle();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(posted).toEqual([TOKEN, TOKEN]);
    expect(view.getByRole('heading', { name: 'Your address is verified' })).toBeDefined();
  });
});

describe('the wizard, when what it needs could not be read', () => {
  test('says the server could not be checked, and asks again when told to', async () => {
    let asked = 0;
    const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }), {
      api: anApi({
        setupStatus: () => {
          asked += 1;
          return asked === 1
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'no'))
            : Promise.resolve({ open: true, appUrl: ORIGIN });
        },
      }),
    });
    expect(view.getByText('Could not check this server')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asked).toBe(2);
    expect(view.queryByText('Could not check this server')).toBeNull();
    expect(view.getByText('Step 2 of 8')).toBeDefined();
  });

  test('says the setup could not be read, and asks again when told to', async () => {
    let asked = 0;
    const view = await openSetup(
      aClient({
        state: () => {
          asked += 1;
          return asked === 1
            ? Promise.reject(new SetupFailure(500, 'INTERNAL', 'no'))
            : Promise.resolve(aState());
        },
      }),
    );
    expect(view.getByText('Could not read the setup')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asked).toBe(2);
    expect(view.queryByText('Could not read the setup')).toBeNull();
  });
});

describe('a value to copy', () => {
  test('says Copied only once the clipboard took it', async () => {
    const written: string[] = [];
    const clipboard = spyOn(navigator.clipboard, 'writeText').mockImplementation((text) => {
      written.push(text);
      return Promise.resolve();
    });
    const view = await renderApp(<CopyField label="Address" value="https://purlay.test" />);
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(written).toEqual(['https://purlay.test']);
    expect(view.getByRole('button', { name: 'Copied' })).toBeDefined();
    clipboard.mockRestore();
  });

  test('stays at Copy when the clipboard refuses, so the person is not told it worked', async () => {
    const clipboard = spyOn(navigator.clipboard, 'writeText').mockRejectedValue(
      new Error('denied'),
    );
    const view = await renderApp(<CopyField label="Address" value="https://purlay.test" />);
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(view.getByRole('button', { name: 'Copy' })).toBeDefined();
    expect(view.queryByRole('button', { name: 'Copied' })).toBeNull();
    clipboard.mockRestore();
  });
});

describe('the test client', () => {
  test('refuses a call nobody expected, and names it', async () => {
    const client = aClient();
    const calls: [string, () => Promise<unknown>][] = [
      ['claim', (): Promise<void> => client.claim('x')],
      ['state', (): Promise<unknown> => client.state()],
      ['finish', (): Promise<void> => client.finish()],
    ];
    for (const [name, call] of calls) {
      let message = '';
      try {
        await call();
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      expect(message).toBe(`the test did not expect client.${name} to be called`);
    }
  });
});

describe('the motion hook, rendered where there is no browser', () => {
  const Probe = (): React.JSX.Element => <p>{useReducedMotion() ? 'still' : 'moving'}</p>;

  test('says there is motion: nothing has asked for less', () => {
    expect(renderToString(<Probe />)).toContain('moving');
  });
});
