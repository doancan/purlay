/**
 * What chat tells the shell (D-250, `docs/MODULES.md` §6): its routes, the places it puts on the rail and in the
 * palette, its keys and its settings pages. Data only — the screens are `chat.ts`, behind `load`.
 */
import { CHAT_AUDIT_ACTIONS } from '@purlay/types';
import { defineModule, shortcut, type ModuleScreens } from '../../modules/manifest';

const routes = {
  channel: '/w/:slug/c/:channelId',
  questions: '/w/:slug/questions',
  inbox: '/w/:slug/inbox',
  search: '/w/:slug/search',
  saved: '/w/:slug/saved',
  drafts: '/w/:slug/drafts',
  unreads: '/w/:slug/unreads',
  followed: '/w/:slug/followed',
} as const;

/** The screens `chat.ts` must export: one for each route above, so a route without a screen does not compile. */
export type ChatScreens = ModuleScreens<typeof routes>;

export const chat = defineModule({
  id: 'chat',
  load: () => import('./chat'),
  // The channel is where a person lands: the chunk is asked for before anything waits on it.
  preload: true,
  // The shell's bar holds the navigation toggle on a narrow window, the frame a cold load is measured to.
  waiting: 'bar',
  routes,
  rail: [
    // The conversations: the workspace's front door, which opens the channel you were last in.
    { route: 'workspace', glyph: 'channels', label: 'sidebar.channels' },
    { route: 'inbox', glyph: 'inbox', label: 'inbox.title' },
    { route: 'questions', glyph: 'open-question', label: 'sidebar.questions' },
    { route: 'search', glyph: 'search', label: 'search.title' },
    { route: 'saved', glyph: 'saved', label: 'saved.title' },
    { route: 'drafts', glyph: 'edit', label: 'drafts.title' },
  ],
  palette: [
    { route: 'questions', glyph: 'open-question', label: 'questions.title' },
    { route: 'inbox', glyph: 'inbox', label: 'inbox.title' },
    { route: 'saved', glyph: 'saved', label: 'saved.title' },
    { route: 'drafts', glyph: 'edit', label: 'drafts.title' },
    { route: 'unreads', glyph: 'channels', label: 'unreads.title' },
    { route: 'followed', glyph: 'notifications', label: 'followed.title' },
    { route: 'search', glyph: 'search', label: 'search.title' },
  ],
  shortcuts: [
    shortcut(
      'shortcuts.group.navigation',
      'shortcuts.channels',
      (k) => [
        [k.alt, '↑'],
        [k.alt, '↓'],
      ],
      'shortcuts.close',
    ),
    shortcut(
      'shortcuts.group.navigation',
      'shortcuts.rowMenu',
      (k) => [[k.shift, 'F10']],
      'shortcuts.channels',
    ),
    shortcut(
      'shortcuts.group.navigation',
      'shortcuts.readAll',
      (k) => [[k.shift, k.escape]],
      'shortcuts.deepWork',
    ),
    shortcut('shortcuts.group.messages', 'shortcuts.move', () => [['↑'], ['↓']]),
    shortcut('shortcuts.group.messages', 'shortcuts.thread', () => [['T']]),
    shortcut('shortcuts.group.messages', 'shortcuts.reply', () => [['R']]),
    shortcut('shortcuts.group.messages', 'shortcuts.edit', () => [['E']]),
    shortcut('shortcuts.group.messages', 'shortcuts.resolve', (k) => [[k.mod, k.shift, 'R']]),
    shortcut('shortcuts.group.composer', 'shortcuts.send', (k) => [[k.enter]]),
    shortcut('shortcuts.group.composer', 'shortcuts.newline', (k) => [[k.shift, k.enter]]),
    shortcut('shortcuts.group.composer', 'shortcuts.codeSend', (k) => [[k.mod, k.enter]]),
    shortcut('shortcuts.group.composer', 'shortcuts.bold', (k) => [[k.mod, 'B']]),
    shortcut('shortcuts.group.composer', 'shortcuts.italic', (k) => [[k.mod, 'I']]),
    shortcut('shortcuts.group.composer', 'shortcuts.strike', (k) => [[k.mod, k.shift, 'X']]),
    shortcut('shortcuts.group.composer', 'shortcuts.inlineCode', (k) => [[k.mod, 'E']]),
    shortcut('shortcuts.group.composer', 'shortcuts.codeBlock', (k) => [
      [k.mod, k.alt, k.shift, 'C'],
    ]),
    shortcut('shortcuts.group.composer', 'shortcuts.link', (k) => [[k.mod, k.shift, 'U']]),
    shortcut('shortcuts.group.composer', 'shortcuts.bullets', (k) => [[k.mod, k.shift, '8']]),
    shortcut('shortcuts.group.composer', 'shortcuts.numbers', (k) => [[k.mod, k.shift, '7']]),
    shortcut('shortcuts.group.composer', 'shortcuts.quote', (k) => [[k.mod, k.shift, '9']]),
    shortcut('shortcuts.group.composer', 'shortcuts.editLast', () => [['↑']]),
    shortcut('shortcuts.group.composer', 'shortcuts.preview', (k) => [[k.mod, k.shift, 'P']]),
  ],
  settings: [
    {
      id: 'notifications',
      group: 'account',
      glyph: 'notifications',
      for: 'everyone',
      after: 'preferences',
    },
    {
      id: 'integrations',
      group: 'workspace',
      glyph: 'integration',
      for: 'admins',
      after: 'invitations',
    },
  ],
  auditActions: CHAT_AUDIT_ACTIONS,
  // Chat's notifications are its own list in the inbox, bound to a message (D-250 §1); it writes none to the core's.
  notices: {},
});
