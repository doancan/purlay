/**
 * A channel on screen, with everything it touches in the test's hands.
 *
 * The real tree: session, workspace, the realtime provider, the channel screen — over an
 * `Api` the test wrote, a socket it drives, scroll measurements it sets and observers it
 * fires. What the harness adds is a `<main>` with a text box in it, because the feed's
 * Escape goes "to the composer" and the composer is another slice's component.
 */
import { act } from '@testing-library/react';
import { useRef } from 'react';
import type { Channel, Message, MessagePage, User } from '@purlay/types';
import type { Api } from '../data/api';
import { ChannelScreen } from '../features/channel/channel-screen';
import { FeedPortsContext } from '../features/channel/feed-ports';
import { ContentPortsContext } from '../features/content/content-ports';
import { SessionGate } from '../features/session/session';
import { WorkspaceScopeProvider } from '../features/shell/workspace';
import { RealtimeProvider, useEngine } from '../realtime/realtime-provider';
import type { Engine } from '../realtime/engine';
import { feedWorld, installScrollMetrics, type FeedWorld, type ScrollMetrics } from './feed-world';
import { IDS, WHEN, aSignedInApi } from './fixtures';
import { renderApp } from './render';

export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

export const page = (data: readonly Message[], nextCursor: string | null = null): MessagePage => ({
  // The API answers newest first.
  data: [...data].sort((a, b) => (a.id < b.id ? 1 : -1)),
  nextCursor,
});

export interface ChannelOptions {
  readonly channelId?: string;
  readonly api?: Partial<Api>;
  readonly channels?: Channel[];
  /** The workspace's members, by username, for mentions. */
  readonly members?: readonly { readonly user: User; readonly role?: 'member' | 'owner' }[];
  readonly messages?: MessagePage | (() => Promise<MessagePage>);
  readonly locale?: 'en' | 'tr';
  readonly dark?: boolean;
  /** Layout numbers the feed reads at the moment it mounts. */
  readonly layout?: Partial<Pick<ScrollMetrics, 'scrollHeight' | 'clientHeight' | 'markerTop'>>;
}

export type ChannelView = Awaited<ReturnType<typeof renderApp>> & {
  readonly feed: FeedWorld;
  readonly metrics: ScrollMetrics;
  readonly engine: () => Engine;
  readonly scroller: () => HTMLElement;
  readonly unmountAll: () => void;
};

const EngineProbe = ({ capture }: { readonly capture: (engine: Engine) => void }): null => {
  capture(useEngine());
  return null;
};

const Region = ({
  channelId,
  capture,
}: {
  readonly channelId: string;
  readonly capture: (engine: Engine) => void;
}): React.JSX.Element => {
  // A composer stand-in with the attribute the feed looks for.
  const box = useRef<HTMLTextAreaElement>(null);
  return (
    <main>
      <EngineProbe capture={capture} />
      <ChannelScreen channelId={channelId} />
      <textarea ref={box} data-composer="" aria-label="Write a message" />
    </main>
  );
};

/** Mounts a channel and lets its queries answer. Scroll metrics are installed until `unmountAll`. */
export const mountChannel = async (options: ChannelOptions = {}): Promise<ChannelView> => {
  const { metrics, restore } = installScrollMetrics();
  metrics.scrollHeight = options.layout?.scrollHeight ?? 1000;
  metrics.clientHeight = options.layout?.clientHeight ?? 400;
  metrics.markerTop = options.layout?.markerTop ?? 0;
  const feed = feedWorld();
  let engine: Engine | null = null;
  const messages = options.messages ?? page([]);
  const api = aSignedInApi({
    messages: () => (typeof messages === 'function' ? messages() : Promise.resolve(messages)),
    members: () =>
      Promise.resolve(
        (options.members ?? []).map((m) => ({
          user: m.user,
          role: m.role ?? 'member',
          joinedAt: WHEN,
        })),
      ),
    unresolved: () => Promise.resolve({ data: [], nextCursor: null }),
    ...(options.channels === undefined
      ? {}
      : { channels: (): Promise<Channel[]> => Promise.resolve(options.channels ?? []) }),
    ...options.api,
  });
  const view = await renderApp(
    <FeedPortsContext.Provider value={feed.ports}>
      <ContentPortsContext.Provider
        value={{ highlight: () => Promise.resolve(null), copy: () => Promise.resolve() }}
      >
        <SessionGate>
          <WorkspaceScopeProvider slug="acme" notFound={null}>
            <RealtimeProvider>
              <Region
                channelId={options.channelId ?? IDS.api}
                capture={(found) => {
                  engine = found;
                }}
              />
            </RealtimeProvider>
          </WorkspaceScopeProvider>
        </SessionGate>
      </ContentPortsContext.Provider>
    </FeedPortsContext.Provider>,
    {
      api,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.dark === undefined ? {} : { dark: options.dark }),
    },
  );
  await settle();
  return Object.assign(view, {
    feed,
    metrics,
    engine: (): Engine => {
      if (engine === null) throw new Error('the engine was not mounted');
      return engine;
    },
    scroller: (): HTMLElement => {
      const el = view.container.querySelector<HTMLElement>('.overflow-y-auto');
      if (el === null) throw new Error('the feed has no scroller on screen');
      return el;
    },
    unmountAll: (): void => {
      view.unmount();
      restore();
    },
  });
};
