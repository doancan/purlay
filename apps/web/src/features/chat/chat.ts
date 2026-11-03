/**
 * Chat's screens, in one chunk (D-250, `docs/MODULES.md` §6). Each door asks for this module with `import()`
 * (`load.tsx`) and nothing imports it statically, so none of chat's code is in the shell's chunk: a server
 * that does not run chat is never sent it, and `budget:web` fails the build if it is.
 */
export { ChannelScreen } from '../channel/channel-screen';
export { DraftsScreen } from '../drafts/drafts-screen';
export { InboxScreen } from '../inbox/inbox-screen';
export { QuestionsScreen } from '../questions/questions-screen';
export { SavedScreen } from '../saved/saved-screen';
export { SearchScreen } from '../search/search-screen';
export { UnreadsScreen } from '../unreads/unreads-screen';
