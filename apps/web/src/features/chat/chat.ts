/**
 * Chat's screens, in one chunk (D-250, `docs/MODULES.md` §6). The manifest's `load` asks for this module with
 * `import()` (`manifest.ts`) and nothing imports it statically, so none of chat's code is in the shell's chunk: a
 * server that does not run chat is never sent it, and `budget:web` fails the build if it is.
 */
import { createElement, lazy } from 'react';
import { ChannelScreen } from './channel/channel-screen';
import { DraftsScreen } from './drafts/drafts-screen';
import { InboxScreen } from './inbox/inbox-screen';
import { QuestionsScreen } from './questions/questions-screen';
import { SavedScreen } from './saved/saved-screen';
import { SearchScreen } from './search/search-screen';
import { UnreadsScreen } from './unreads/unreads-screen';
import type { ChatScreens } from './manifest';
const FollowedScreen = lazy(async () => ({
  default: (await import('./followed/followed-screen')).FollowedScreen,
}));

/** What the manifest's `load` reads: the screen of each of chat's routes, given what its address names. */
export const screens: ChatScreens = {
  channel: ({ params }) => createElement(ChannelScreen, { channelId: params.channelId }),
  drafts: DraftsScreen,
  inbox: InboxScreen,
  questions: QuestionsScreen,
  saved: SavedScreen,
  search: SearchScreen,
  unreads: UnreadsScreen,
  followed: () => createElement(FollowedScreen),
};
