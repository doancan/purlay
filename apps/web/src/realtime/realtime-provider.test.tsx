/**
 * What a screen reads of the connection: its state, and what is still in flight.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { SessionGate } from '../features/session/session';
import { WorkspaceScopeProvider } from '../features/shell/workspace';
import { errorOf } from '../testing/boundary';
import { installDom } from '../testing/dom';
import { IDS, aSignedInApi } from '../testing/fixtures';
import { renderApp } from '../testing/render';
import { RealtimeProvider, useConnectionStatus, useEngine, usePending } from './realtime-provider';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe('the connection as a screen sees it', () => {
  test('its status follows the socket, and a sent message is in flight until the server says', async () => {
    let status = '';
    let inFlight = 0;
    let send: (text: string) => string = () => '';
    const Probe = (): null => {
      const engine = useEngine();
      status = useConnectionStatus();
      inFlight = usePending().length;
      send = (content): string => engine.send({ channelId: IDS.api, content });
      return null;
    };
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <RealtimeProvider>
            <Probe />
          </RealtimeProvider>
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: aSignedInApi() },
    );
    await settle();
    expect(status).toBe('connecting');
    act(() => {
      view.world.sockets.open();
    });
    expect(status).toBe('open');
    act(() => {
      send('hello');
    });
    expect(inFlight).toBe(1);
    expect(view.world.sockets.sent('MESSAGE_SEND')[0]?.payload).toMatchObject({
      channelId: IDS.api,
      content: 'hello',
    });
  });

  test("the browser's offline and online reach the connection at once (#626)", async () => {
    let status = '';
    const Probe = (): null => {
      status = useConnectionStatus();
      return null;
    };
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <RealtimeProvider>
            <Probe />
          </RealtimeProvider>
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: aSignedInApi() },
    );
    await settle();
    act(() => {
      view.world.sockets.open();
    });
    expect(status).toBe('open');
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(status).toBe('waiting');
    const before = view.world.sockets.sockets.length;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // Within the first rung's jittered second, not at the end of whatever wait it was in.
    act(() => {
      view.world.timers.advance(1_000);
    });
    expect(status).toBe('connecting');
    expect(view.world.sockets.sockets.length).toBe(before + 1);
    act(() => {
      view.world.sockets.open();
    });
    view.unmount();
    // Gone with the provider: an event after it is nobody's business.
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(status).toBe('open');
  });

  test('asking without a connection above says what is missing', () => {
    const Probe = (): null => {
      useEngine();
      return null;
    };
    expect(errorOf(<Probe />)).toBe('useEngine was called outside a RealtimeProvider');
  });
});
