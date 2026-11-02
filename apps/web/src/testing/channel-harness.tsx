/**
 * A channel on screen, with everything it touches in the test's hands.
 *
 * The real tree: session, workspace, the realtime provider, the channel screen — over an
 * `Api` the test wrote, a socket it drives, scroll measurements it sets and observers it
 * fires. What the harness adds is a `<main>` with a text box in it, because the feed's
 * Escape goes "to the composer" and the composer is another slice's component.
 */
import { afterEach } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, Message, MessagePage, Profile, User } from '@purlay/types';
import type { Api } from '../data/api';
import { ChannelScreen } from '../features/channel/channel-screen';
import { Main } from '../ui/main';
import { Toaster } from '../ui/toast';
import { FeedPortsContext } from '../features/channel/feed-ports';
import { ContentPortsContext } from '../features/content/content-ports';
import { SessionGate } from '../features/session/session';
import { SaveIntentsProvider } from '../features/saved/save-toggle';
import { WorkspaceScopeProvider } from '../features/shell/workspace';
import { RealtimeProvider, useEngine } from '../realtime/realtime-provider';
import { OutboxProvider } from '../features/composer/uploads';
import type { Engine } from '../realtime/engine';
import { feedWorld, installScrollMetrics, type FeedWorld, type ScrollMetrics } from './feed-world';
import { IDS, WHEN, aSignedInApi, NO_PROFILE } from './fixtures';
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
  readonly members?: readonly {
    readonly user: User;
    readonly role?: 'member' | 'admin' | 'owner';
    readonly profile?: Profile;
  }[];
  readonly messages?: MessagePage | (() => Promise<MessagePage>);
  readonly locale?: 'en' | 'tr';
  /** What Copy does; resolved by default. */
  readonly copy?: (text: string) => Promise<void>;
  /** The address the page starts at, for a channel opened by a link (`?thread=`). */
  readonly path?: string;
  readonly dark?: boolean;
  /** The top row is on screen and stays there (see `FeedWorld.stayInView`). */
  readonly topStaysInView?: boolean;
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
  return (
    <Main>
      <EngineProbe capture={capture} />
      <ChannelScreen channelId={channelId} />
      <Toaster dismissLabel="Close" />
    </Main>
  );
};

/**
 * What a test that failed before `unmountAll` left mounted. Its scroll metrics are patched onto
 * the prototype, so left in place they would fail the next file's tests for a reason that is
 * not theirs.
 */
const leftover = new Set<() => void>();
afterEach(() => {
  for (const cleanup of leftover) cleanup();
  leftover.clear();
});

/** Mounts a channel and lets its queries answer. Scroll metrics are installed until `unmountAll`. */
export const mountChannel = async (options: ChannelOptions = {}): Promise<ChannelView> => {
  const { metrics, restore } = installScrollMetrics();
  metrics.scrollHeight = options.layout?.scrollHeight ?? 1000;
  metrics.clientHeight = options.layout?.clientHeight ?? 400;
  metrics.markerTop = options.layout?.markerTop ?? 0;
  const feed = feedWorld();
  feed.stayInView = options.topStaysInView ?? false;
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
          profile: m.profile ?? NO_PROFILE,
        })),
      ),
    unresolved: () => Promise.resolve({ data: [], nextCursor: null }),
    // The details an owner opens list the channel's repository feeds (D-134): none, unless a test says.
    githubFeeds: () => Promise.resolve([]),
    // And its incoming webhooks beside them (D-245): none, unless a test says.
    incomingWebhooks: () => Promise.resolve([]),
    ...(options.channels === undefined
      ? {}
      : { channels: (): Promise<Channel[]> => Promise.resolve(options.channels ?? []) }),
    ...options.api,
  });
  const view = await renderApp(
    <FeedPortsContext.Provider value={feed.ports}>
      <ContentPortsContext.Provider
        value={{
          highlight: () => Promise.resolve(null),
          copy: options.copy ?? ((): Promise<void> => Promise.resolve()),
        }}
      >
        <SessionGate>
          <WorkspaceScopeProvider slug="acme" notFound={null}>
            <RealtimeProvider>
              <OutboxProvider>
                <SaveIntentsProvider>
                  <Region
                    channelId={options.channelId ?? IDS.api}
                    capture={(found) => {
                      engine = found;
                    }}
                  />
                </SaveIntentsProvider>
              </OutboxProvider>
            </RealtimeProvider>
          </WorkspaceScopeProvider>
        </SessionGate>
      </ContentPortsContext.Provider>
    </FeedPortsContext.Provider>,
    {
      api,
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      ...(options.dark === undefined ? {} : { dark: options.dark }),
    },
  );
  const unmountAll = (): void => {
    if (!leftover.delete(unmountAll)) return;
    view.unmount();
    restore();
  };
  leftover.add(unmountAll);
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
    unmountAll,
  });
};
