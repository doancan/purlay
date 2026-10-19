/**
 * What the first page does not need to read a conversation, in one chunk (D-49, D-159, D-163): the
 * settings (D-146), the image viewer, and the overlays a person opens on purpose — the command
 * palette, the shortcut reference, the sidebar's dialogs, a group's details, adding people to a
 * channel and a sidebar row's context menu (D-165). Each door asks for this module with `import()`, and
 * nothing imports it statically, so none of it counts against the initial budget.
 *
 * **One chunk, so one preload fetches every door.** The shell asks for it once the first screen is
 * drawn (`deferred-door.ts`): an overlay opened by a key has no pointer to preload it on. D-159's
 * first reason is gone — two lazy chunks no longer push what they share with the entry into a third,
 * preloaded chunk, because the build puts every initial module in the entry (`vite.config.ts`) — but
 * a second deferred chunk would be a second preload to remember. A later deferred feature joins this
 * module rather than becoming another `import()`.
 */
export { SettingsNav, SettingsScreen } from '../features/settings/settings-screen';
export { ImageViewer } from '../features/messages/image-viewer';
export { CommandPalette } from '../features/palette/command-palette';
export { ShortcutsDialog } from '../features/shortcuts/shortcuts-dialog';
export { NewChannelDialog } from '../features/sidebar/new-channel-dialog';
export { BrowseChannelsDialog } from '../features/sidebar/browse-channels-dialog';
export { InviteDialog } from '../features/sidebar/invite-dialog';
export { NewConversationDialog } from '../features/conversations/new-conversation';
export { GroupDetailsDialog } from '../features/conversations/group-details';
export { AddPeopleDialog } from '../features/channel/add-people';
export { RowMenu } from '../features/sidebar/row-menu-body';
