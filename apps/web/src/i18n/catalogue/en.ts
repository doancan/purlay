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
  'sidebar.jump': 'to jump',
  'sidebar.private': 'private',
  'sidebar.you': 'you',
  'sidebar.mentions': {
    one: '{count} unread mention',
    other: '{count} unread mentions',
  },
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
  'workspace.create.failed': 'The workspace was not created. Try again.',
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
  'newChannel.taken': 'A channel with that name already exists. Choose another.',
  'newChannel.invalid':
    'Use lowercase letters, numbers and hyphens, starting with a letter or number.',
  'newChannel.failed': 'The channel was not created. Try again.',

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
  'channel.join.failed': 'Could not join the channel. Try again.',
  'message.reactWith': 'React with {emoji}',
  'message.quickReactions': 'Quick reactions',
  'message.reactionOf': {
    one: '{emoji}, {count} reaction',
    other: '{emoji}, {count} reactions',
  },
  'message.code.language': 'Language: {language}',
  'message.code.plain': 'text',
  'message.link.external': 'Opens in a new tab',
  'message.reactionFailed': 'The reaction was not saved. Try again.',
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

  // ── Keyboard shortcuts (UX §7) ──────────────────────────────────────────
  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.description': 'Everything you can do with a mouse you can do with these.',
  'shortcuts.palette': 'Open the command palette',
  'shortcuts.reference': 'Show this list',
  'shortcuts.close': 'Close the topmost thing',
  'shortcuts.move': 'Move between messages',
  'shortcuts.thread': 'Expand or collapse the focused thread',
  'shortcuts.reply': 'Reply to the focused message',
  'shortcuts.resolve': 'Resolve or reopen the focused thread',
  'shortcuts.channels': 'Previous or next unread channel',
  'shortcuts.send': 'Send the message',
  'shortcuts.newline': 'Add a line to the message',
  'shortcuts.group.navigation': 'Navigation',
  'shortcuts.group.messages': 'Messages',
  'shortcuts.group.composer': 'Composer',
} as const satisfies Record<string, Message>;
