/**
 * The interface's words, in English — and the source of the `Catalogue` type.
 *
 * Written the way the interface speaks (`UX.md`, D-41): sentence case, plain verbs,
 * an action named the same everywhere it appears ("Resolve" is "Resolved" in the
 * line it produces), an error that says what happened and what to do and never
 * apologises, an empty screen that invites the next action. Only the product's own
 * chrome is here — what people write to each other is never translated.
 *
 * Keys are `area.thing`, flat, so a typo is a type error and a search finds every
 * use. A `{name}` is a placeholder; a plural is an object, and its count is the
 * placeholder `{count}`.
 */
import type { Message } from '../types';

export const en = {
  // ── Common ──────────────────────────────────────────────────────────────
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.create': 'Create',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.retry': 'Retry',
  'common.undo': 'Undo',
  'common.loading': 'Loading',

  // ── The application ─────────────────────────────────────────────────────
  'app.skip': 'Skip to the conversation',
  'app.placeholder.title': 'This screen is not built yet',
  'app.placeholder.body': 'The frame around it is final; the screen arrives with its backend.',
  'app.notFound.title': 'Nothing here',
  'app.notFound.body': 'This address does not lead anywhere in Purlay.',
  'app.notFound.home': 'Go to your channels',

  // ── Sign in ─────────────────────────────────────────────────────────────
  'signIn.title': 'Sign in to Purlay',
  'signIn.lede': 'Team chat where a question stays open until somebody closes it.',
  'signIn.github': 'Continue with GitHub',
  'signIn.failed': 'Sign-in did not finish. Try again.',
  'signIn.ended': 'Your session ended. Sign in again to carry on.',
  'signIn.scope': 'Purlay asks GitHub for your name, username and email, and nothing else.',

  // ── Workspace and sidebar ───────────────────────────────────────────────
  'sidebar.label': 'Workspace',
  'sidebar.switch': 'Switch workspace',
  'sidebar.questions': 'Open questions',
  'sidebar.channels': 'Channels',
  'sidebar.people': 'People',
  'sidebar.newChannel': 'New channel',
  'sidebar.jump': 'Jump to…',
  'sidebar.private': 'private',
  'sidebar.you': 'you',
  'sidebar.mentions': {
    one: '{count} unread mention',
    other: '{count} unread mentions',
  },

  // ── Sidebar chrome ──────────────────────────────────────────────────────
  'sidebar.workspaces': 'Workspaces',
  'sidebar.signedInAs': 'Signed in as {name}',
  'sidebar.browse': 'Browse channels',
  'sidebar.questions.many': '99+',
  'sidebar.unread': 'unread',
  'sidebar.dm.failed': 'The conversation could not be opened.',
  'sidebar.people.empty': 'Nobody else is here yet.',

  // ── Narrow window (UX §2): the sidebar is an overlay ─────────────────────
  'nav.open': 'Open navigation',
  'nav.description': 'Channels, people and open questions',

  'browse.title': 'Browse channels',
  'browse.description': 'Public channels you have not joined yet.',
  'browse.join': 'Join',
  'browse.joinLabel': 'Join {name}',
  'browse.joinFailed': 'You could not join the channel.',
  'browse.loading': 'Loading channels',
  'browse.empty.title': 'Nothing to join',
  'browse.empty.body': 'You are in every public channel there is.',
  'browse.error.title': "Couldn't load channels",
  'browse.error.body': 'The server did not answer. Try again.',
  'workspace.none.title': 'You are not in a workspace yet',
  'workspace.none.body':
    'Ask an owner to add you, or sign in with the account that already belongs to one.',
  'workspace.create.title': 'Create a workspace',
  'workspace.create.body': 'A workspace is where one team talks. You can invite the others after.',
  'workspace.create.name': 'Name',
  'workspace.create.slug': 'Address',
  'workspace.create.slugHint':
    'Lowercase letters, numbers and hyphens. It is part of the web address and cannot be changed.',
  'workspace.create.submit': 'Create workspace',
  'workspace.create.taken': 'That address is taken. Choose another.',
  'workspace.create.invalid':
    'Use lowercase letters, numbers and hyphens, starting with a letter or number.',
  'workspace.create.failed': 'The workspace was not created.',
  'state.session.error.title': "Couldn't reach Purlay",
  'state.session.error.body': 'The server did not answer. You are still signed in; try again.',
  'state.channel.missing.title': 'That channel is not here',
  'state.channel.missing.body': 'It does not exist, or you cannot see it.',
  'state.workspace.empty.title': 'Pick a channel',
  'state.workspace.empty.body': 'Choose one from the list, or create the first.',

  // ── New channel ─────────────────────────────────────────────────────────
  'newChannel.title': 'New channel',
  'newChannel.description': 'Anyone in the workspace can find and join a public channel.',
  'newChannel.name': 'Name',
  'newChannel.nameHint': 'Lowercase letters, numbers and hyphens. Up to 64 characters.',
  'newChannel.topic': 'Topic',
  'newChannel.topicHint': 'Optional. One line on what the channel is for.',
  'newChannel.create': 'Create channel',
  'newChannel.private': 'Private',
  'newChannel.privateHint': 'Only the people in it can see it. A member brings others in.',
  'people.add': 'Add people',
  'people.title': 'Add people to {name}',
  'people.description': 'They see the channel at once, with what was said in it.',
  'people.filter': 'Find a person',
  'people.addOne': 'Add',
  'people.added': 'Added',
  'people.loading': 'Loading people…',
  'people.failed': 'The people of this workspace could not be loaded.',
  'people.none': 'Nobody else is in this workspace yet.',
  'people.noMatch': 'Nobody by that name.',
  'people.addFailed': '{name} was not added.',
  'newChannel.taken': 'A channel with that name already exists. Choose another.',
  'newChannel.invalid':
    'Use lowercase letters, numbers and hyphens, starting with a letter or number.',
  'newChannel.failed': 'The channel was not created.',

  // ── Channel header ──────────────────────────────────────────────────────
  'header.views': 'Channel views',
  'header.feed': 'Feed',
  'header.questions': 'Open questions',
  'header.noTopic': 'No topic yet',

  // ── Messages ────────────────────────────────────────────────────────────
  'message.react': 'React',
  'message.reacted': 'Reacted',
  'message.reply': 'Reply',
  'message.edited': 'edited',
  'message.deleted': 'This message was deleted.',
  'message.edit': 'Edit',
  'message.delete': 'Delete',
  'message.editLabel': 'Edit your message',
  'message.editSave': 'Save',
  'message.editHint': 'Enter to save · Esc to cancel',
  'message.editFailed': 'Your edit was not saved.',
  'message.deleteTitle': 'Delete this message?',
  'message.deleteBody': 'It is replaced by a note that it was deleted. Its replies stay.',
  'message.deleteFailed': 'The message was not deleted.',
  'message.more': 'More',
  'message.mention': 'You were mentioned',
  'message.newMarker': 'New',
  'message.newMessages': {
    one: '{count} new message',
    other: '{count} new messages',
  },
  'message.jumpToNew': 'Jump to new messages',
  'message.today': 'Today',
  'message.yesterday': 'Yesterday',
  'message.reactions': {
    one: '{count} reaction',
    other: '{count} reactions',
  },
  'message.addReaction': 'Add reaction',
  'message.removeReaction': 'Remove your reaction',
  'message.code.copy': 'Copy code',
  'message.code.expand': 'Show all {count} lines',
  'message.code.collapse': 'Show fewer lines',
  'message.code.lines': {
    one: '{count} line',
    other: '{count} lines',
  },

  // ── The feed (D-98) ─────────────────────────────────────────────────────
  'feed.label': 'Messages in {channel}',
  'feed.row': '{name}, {when}',
  'feed.dmTitle': 'Direct message with {name}',
  'feed.selfDm': '{name} (you)',
  'feed.olderLoading': 'Loading older messages',
  'feed.olderError': "Couldn't load older messages",
  'feed.olderRetry': 'Try again',
  'feed.start': 'This is the beginning of the channel',
  'channel.join.notice': 'You are reading #{name} without being a member.',
  'channel.join.action': 'Join channel',
  'channel.join.failed': 'Could not join the channel.',
  'message.reactWith': 'React with {emoji}',
  'message.quickReactions': 'Quick reactions',
  'message.reactionOf': {
    one: '{emoji}, {count} reaction',
    other: '{emoji}, {count} reactions',
  },
  'message.code.language': 'Language: {language}',
  'message.code.plain': 'text',
  'message.link.external': 'Opens in a new tab',
  'message.table': 'Table',
  'message.task.done': 'Done',
  'message.task.open': 'Not done',
  'message.reactionFailed': 'The reaction was not saved.',
  'reaction.thumbsUp': 'Thumbs up',
  'reaction.heart': 'Heart',
  'reaction.celebrate': 'Celebrate',
  'reaction.eyes': 'Looking',
  'reaction.rocket': 'Ship it',
  'reaction.done': 'Done',
  'reaction.smile': 'Smile',

  // ── Delivery (UX §3.1) ──────────────────────────────────────────────────
  'delivery.sending': 'Sending',
  'delivery.sent': 'Sent',
  'delivery.failed': 'Failed to send',
  'delivery.retry': 'Retry',
  'delivery.delete': 'Delete',
  'delivery.announce.sent': 'Message sent',
  'delivery.announce.failed': 'Message failed to send',

  // ── Threads (UX §4) ─────────────────────────────────────────────────────
  'thread.label': 'Thread by {name}: {status}',
  'thread.status.open': 'open',
  'thread.status.resolved': 'resolved',
  'thread.replies': {
    one: '{count} reply',
    other: '{count} replies',
  },
  'thread.open': 'Open · {replies} · last {when}',
  'thread.resolved': 'Resolved by {name} · {replies}',
  'thread.show': 'Show thread',
  'thread.collapse': 'Collapse',
  'thread.resolve': 'Resolve',
  'thread.reopen': 'Reopen',
  'thread.replyPlaceholder': 'Reply to thread…',
  'thread.replyLabel': 'Reply to thread',
  'thread.loading': 'Loading replies…',
  'thread.error': "Couldn't load replies",
  'thread.announce.resolved': 'Thread resolved',
  'thread.announce.reopened': 'Thread reopened',

  // ── Threads, in place (D-98) ────────────────────────────────────────────
  'thread.reply': 'Reply',
  'thread.loadMore': 'Load more replies',
  'thread.none': 'No replies yet',
  'thread.composerName': 'a thread in {channel}',
  'thread.resolveFailed': 'Only a thread with at least one reply can be resolved.',
  'thread.actionFailed': 'The thread was not changed.',

  // ── Composer (UX §5) ────────────────────────────────────────────────────
  'composer.label': 'Message {channel}',
  'composer.placeholder': 'Write to {channel}. Enter sends, Shift+Enter adds a line.',
  'composer.send': 'Send',
  'composer.pasted': 'Pasted text became a code block',
  'composer.tooLong': {
    one: 'That is {count} character over the limit.',
    other: 'That is {count} characters over the limit.',
  },
  'composer.hint.send': 'sends',
  'composer.hint.newline': 'new line',

  // ── Composer: what is checked before a send (D-99 §3) ───────────────────
  'composer.hint.code': 'code block',
  'composer.remaining': {
    one: '{count} character left',
    other: '{count} characters left',
  },
  'composer.invalid': 'This message has a character Purlay cannot send. Remove it and try again.',
  'composer.broadcast':
    '{mention} is not available: Purlay does not notify everybody. Name the person you mean.',

  // ── Connection (UX §8) ──────────────────────────────────────────────────
  'connection.reconnecting': 'Reconnecting… messages will send when you are back',
  'connection.ended': 'Your session ended',

  // ── States (UX §8) ──────────────────────────────────────────────────────
  'state.feed.empty.title': 'No messages yet',
  'state.feed.empty.body':
    'This channel is new. Say what it is for in the first message; the composer below is ready.',
  'state.feed.loading': 'Loading messages',
  'state.feed.error.title': "Couldn't load messages",
  'state.feed.error.body': 'The server did not answer. Your draft is safe.',
  'state.questions.empty.title': 'Every thread is resolved',
  'state.questions.empty.body':
    'A thread appears here the moment it has a reply and no resolution.',
  'state.questions.loading': 'Loading open questions',
  'state.questions.error.title': "Couldn't load open questions",
  'state.questions.error.body': 'The server did not answer. Try again.',
  'state.channels.loading': 'Loading channels',
  'state.channels.error.title': "Couldn't load channels",
  'state.channels.error.body': 'The server did not answer. Try again.',
  'state.channels.empty.title': 'No channels yet',
  'state.channels.empty.body': 'Create the first one; it takes a name and nothing else.',

  // ── A new build (#334) ──────────────────────────────────────────────────
  'update.available': 'Purlay was updated. Reload to get the new version; your drafts are kept.',
  'update.reload': 'Reload',

  // ── Search (D-105) ─────────────────────────────────────────────────────
  'search.title': 'Search',
  'search.label': 'Search messages',
  'search.hint': 'Press Enter to search every channel you can see.',
  'search.searching': 'Searching…',
  'search.tooShort': 'Type at least {min} characters.',
  'search.prompt':
    'The words as typed, ignoring case, in every channel you can see — replies and resolved threads too.',
  'search.more': 'Load more',
  'state.search.empty.title': 'No matches for “{words}”',
  'state.search.empty.body':
    'Searched every channel you can see. A deleted message is never found.',
  'state.search.error.title': "Couldn't search",
  'state.search.error.body': 'The server did not answer. Your words are kept; try again.',

  // ── Deep Work (D-108) ──────────────────────────────────────────────────
  'deepWork.on': 'Deep Work until {until}: nothing interrupts you.',
  'deepWork.end': 'End',
  'deepWork.failed': 'Deep Work was not changed.',
  'shortcuts.deepWork': 'Start or end Deep Work',

  // ── Notification level (D-107) ─────────────────────────────────────────
  'level.label': 'Notify me about',
  'level.button': 'Notifications: {level}',
  'level.all': 'Every message',
  'level.mentions': 'Mentions and replies',
  'level.none': 'Nothing',
  'level.all.short': 'every message',
  'level.mentions.short': 'mentions and replies',
  'level.none.short': 'nothing',
  'level.failed': 'The notification level was not changed.',

  // ── Inbox (D-106) ──────────────────────────────────────────────────────
  'inbox.title': 'Inbox',
  'inbox.lede': 'What you were told, newest first',
  'inbox.why.mention': '{name} mentioned you',
  'inbox.why.direct': '{name} wrote to you',
  'inbox.why.reply': '{name} replied in your thread',
  'inbox.why.resolved': 'Your question was resolved',
  'inbox.why.channel': '{name} wrote',
  'inbox.readAll': 'Mark all read',
  'inbox.readFailed': 'Not marked read.',
  'inbox.more': 'Load more',
  'state.inbox.loading': 'Loading your inbox',
  'state.inbox.error.title': "Couldn't load your inbox",
  'state.inbox.error.body': 'The server did not answer. Try again.',
  'state.inbox.empty.title': 'Nothing needs you',
  'state.inbox.empty.body':
    'When somebody names you, writes to you or answers your thread, it is here.',

  // ── Open questions (UX §4.4) ────────────────────────────────────────────
  'questions.title': 'Open questions',
  'questions.lede': 'Unresolved threads with replies, newest first',
  'questions.count': {
    one: '{count} open question',
    other: '{count} open questions',
  },
  'questions.footer':
    'These are the questions your team has not finished answering. Resolve a thread and it leaves this list.',
  'questions.back': 'Back to {channel}',

  // ── Open questions, the list (D-98) ─────────────────────────────────────
  'questions.replies': '{replies} · {when}',
  'questions.more': 'Load more questions',
  'questions.unnamed': 'A channel you can no longer see',

  // ── Failures: one sentence per cause, shared by every screen ────────────
  'failure.network': 'Check your connection and try again.',
  'failure.session': 'Your session ended. Sign in again to carry on.',
  'failure.gone':
    'This is no longer available. It may have been removed, or you may have lost access.',
  'failure.slow': 'You are going too fast. Wait a moment and try again.',
  'failure.tooLarge': 'It is larger than Purlay takes.',
  'failure.refused': 'That was refused. Check what you entered and try again.',
  'failure.generic': 'Something went wrong on our side. Try again in a moment.',
  'failure.signOut': "Couldn't sign you out.",
  'failure.copy': "Couldn't copy. Select the text and copy it yourself.",
  'connection.degraded': {
    one: 'Live updates are paused for {count} channel',
    other: 'Live updates are paused for {count} channels',
  },
  'connection.stale': 'What you see may be out of date',
  'message.link.opens': 'Opens {host}',

  // ── Theme and language ──────────────────────────────────────────────────
  'theme.label': 'Theme',
  'theme.system': 'System',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'language.label': 'Language',
  'language.en': 'English',
  'language.tr': 'Türkçe',

  // ── Account ─────────────────────────────────────────────────────────────
  'user.menu': 'Account',
  'user.signOut': 'Sign out',
  'user.signOutEverywhere': 'Sign out everywhere',

  // ── Command palette (D-98) ──────────────────────────────────────────────
  'palette.title': 'Command palette',
  'palette.placeholder': 'Jump to a channel, person or view…',
  'palette.empty': 'No match for “{query}”',
  'palette.group.views': 'Views',
  'palette.group.channels': 'Channels',
  'palette.group.people': 'People',
  'palette.group.settings': 'Settings',
  'palette.hint.move': 'move',
  'palette.hint.open': 'open',
  'palette.hint.close': 'close',

  // ── Command palette, continued ──────────────────────────────────────────
  'palette.description': 'Type to find a channel, person or view, then press Enter.',
  'palette.listLabel': 'Results',
  'palette.results': {
    one: '{count} result',
    other: '{count} results',
  },
  'palette.view.feed': 'Feed',
  'palette.error': 'That did not open.',
  'palette.announce.channel': 'Opened {name}',

  // ── Keyboard shortcuts (UX §7) ──────────────────────────────────────────
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.description': 'Everything you can do with a mouse you can do with these.',
  'shortcuts.palette': 'Open the command palette',
  'shortcuts.reference': 'Show this list',
  'shortcuts.close': 'Close the topmost thing',
  'shortcuts.move': 'Move between messages',
  'shortcuts.thread': 'Expand or collapse the focused thread',
  'shortcuts.reply': 'Reply to the focused message',
  'shortcuts.edit': 'Edit your own message',
  'shortcuts.resolve': 'Resolve or reopen the focused thread',
  'shortcuts.channels': 'Previous or next unread channel',
  'shortcuts.send': 'Send the message',
  'shortcuts.newline': 'Add a line to the message',
  'shortcuts.group.navigation': 'Navigation',
  'shortcuts.group.messages': 'Messages',
  'shortcuts.group.composer': 'Composer',

  // ── Keyboard shortcuts, continued ───────────────────────────────────────
  'shortcuts.codeSend': 'Send from inside a code block',
  'shortcuts.or': 'or',
} as const satisfies Record<string, Message>;
