/**
 * The doors to chat's chunk (`chat.ts`, D-250): one `import()` for every screen, drawn inside
 * `ModuleGate`, with the bar and the skeleton the channel draws while its own data comes.
 *
 * **The channel is where a person lands, so the chunk is asked for before anything waits on it.** `Outlet`
 * calls `preloadChat` as soon as the address means a chat screen — in the first commit, in parallel with the
 * request for the session — rather than when the screen is first drawn, which is after the session has
 * arrived. A server that does not run chat costs one chunk to a person who opens a chat address there; the
 * `ModuleGate` still shows it as not found. A failed request is forgotten, so the next door asks again.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ScreenBar } from '../shell/screen-bar';
import type * as Screens from './chat';

let loading: Promise<typeof Screens> | null = null;

export const preloadChat = (): Promise<typeof Screens> => {
  loading ??= import('./chat').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
};

const Channel = lazy(async () => ({ default: (await preloadChat()).ChannelScreen }));
const Drafts = lazy(async () => ({ default: (await preloadChat()).DraftsScreen }));
const Inbox = lazy(async () => ({ default: (await preloadChat()).InboxScreen }));
const Questions = lazy(async () => ({ default: (await preloadChat()).QuestionsScreen }));
const Saved = lazy(async () => ({ default: (await preloadChat()).SavedScreen }));
const Search = lazy(async () => ({ default: (await preloadChat()).SearchScreen }));
const Unreads = lazy(async () => ({ default: (await preloadChat()).UnreadsScreen }));

/**
 * What stands in for a chat screen while its chunk loads: the shell's bar, which holds the navigation toggle on a
 * narrow window — the frame a cold load is measured to — and the skeleton the channel draws while its data comes.
 */
const Waiting = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <>
      <ScreenBar />
      <LoadingStatus label={t('common.loading')} className="p-4">
        <Skeleton className="w-sidebar" />
      </LoadingStatus>
    </>
  );
};

export const LazyChannelScreen = ({
  channelId,
}: {
  readonly channelId: string;
}): React.JSX.Element => (
  <Suspense fallback={<Waiting />}>
    <Channel channelId={channelId} />
  </Suspense>
);

const door =
  (Screen: React.LazyExoticComponent<() => React.JSX.Element>) => (): React.JSX.Element => (
    <Suspense fallback={<Waiting />}>
      <Screen />
    </Suspense>
  );

export const LazyDraftsScreen = door(Drafts);
export const LazyInboxScreen = door(Inbox);
export const LazyQuestionsScreen = door(Questions);
export const LazySavedScreen = door(Saved);
export const LazySearchScreen = door(Search);
export const LazyUnreadsScreen = door(Unreads);
