/**
 * The letter about what a person missed (D-240), in their language (D-41): for each workspace, each
 * conversation's count and its newest few messages — who wrote, a short plain excerpt, and the message's own
 * address in the app (D-149) — then the app, why the letter came, and the link that stops it.
 *
 * - **Other people's words, quoted safely.** Names and excerpts go through `quotable`: no line breaks, no
 *   control or direction characters, no `://` for a mail client to make a link of, and cut short. The subject
 *   is fixed text, so nothing typed reaches a header.
 * - **Only the server's addresses are links.** The letter is `composeLetter`'s: one button to open
 *   Purlay, each message a line with a small link to it, and the link that stops the letters at the foot.
 */
import { excerptOf } from '@purlay/markdown';
import type { PushLocale } from '@purlay/types';
import { composeLetter, type LetterBlock, type LetterItem } from '../../../platform/letter';
import type { MailMessage } from '../../../platform/mail';
import { quotable } from '../../../modules/workspaces/invitation-mail';

/** The newest messages a conversation shows; the rest are counted. */
const EXCERPTS_PER_CONVERSATION = 3;
/** How much of a message an excerpt quotes: a hint of it, the app has the rest. */
const EXCERPT_MAX = 140;

interface MissedMessage {
  readonly id: string;
  /** Who wrote it; null for an author the server no longer knows. */
  readonly author: string | null;
  readonly content: string;
}

export interface MissedConversation {
  readonly channelId: string;
  /** A channel's name; null for a direct message, which is named by who wrote. */
  readonly name: string | null;
  /** Every message the letter counts here, oldest first. */
  readonly messages: readonly MissedMessage[];
}

export interface MissedWorkspace {
  readonly name: string;
  readonly slug: string;
  readonly conversations: readonly MissedConversation[];
}

export interface MissedLetterHead {
  readonly to: string;
  readonly locale: PushLocale;
  readonly appUrl: string;
  /** The token of the link that turns the letters off, carried in the fragment (never a request line). */
  readonly stopToken: string;
  readonly workspaces: readonly MissedWorkspace[];
}

interface Words {
  readonly subject: string;
  readonly intro: string;
  readonly count: (count: number) => string;
  readonly more: (count: number) => string;
  readonly someone: string;
  readonly workspace: string;
  readonly open: string;
  readonly why: string;
  readonly stop: string;
}

const WORDS: Readonly<Record<PushLocale, Words>> = {
  en: {
    subject: 'Messages are waiting for you on Purlay',
    intro: 'Messages that need you have been waiting unread for a while.',
    count: (count) => (count === 1 ? '1 message' : `${String(count)} messages`),
    more: (count) => `and ${String(count)} more`,
    someone: 'Someone',
    workspace: 'A workspace',
    open: 'Open Purlay',
    why: 'You get this because you asked for email about direct messages and mentions you have not read (Settings → Notifications). At most one an hour.',
    stop: 'To stop these emails, open this link:',
  },
  tr: {
    subject: 'Purlay’da seni bekleyen mesajlar var',
    intro: 'Seni ilgilendiren mesajlar bir süredir okunmadan bekliyor.',
    count: (count) => `${String(count)} mesaj`,
    more: (count) => `ve ${String(count)} tane daha`,
    someone: 'Biri',
    workspace: 'Bir çalışma alanı',
    open: 'Purlay’ı aç',
    why: 'Bunu, okumadığın doğrudan mesajlar ve bahsetmeler için e-posta istediğin için alıyorsun (Ayarlar → Bildirimler). Saatte en fazla bir tane.',
    stop: 'Bu e-postaları durdurmak için bu bağlantıyı aç:',
  },
};

/** A conversation as the letter names it: a channel by its name, a direct message by who wrote. */
const nameOf = (conversation: MissedConversation, words: Words): string => {
  if (conversation.name !== null) return `#${quotable(conversation.name, '')}`;
  const authors = [
    ...new Set(
      conversation.messages.map((message) => quotable(message.author ?? '', words.someone)),
    ),
  ];
  return authors.join(', ');
};

const conversationBlock = (
  conversation: MissedConversation,
  workspace: MissedWorkspace,
  head: MissedLetterHead,
  words: Words,
): LetterBlock => {
  const { messages } = conversation;
  const shown = messages.slice(-EXCERPTS_PER_CONVERSATION);
  const items = shown.map((message): LetterItem => {
    const excerpt = quotable(excerptOf(message.content), '', EXCERPT_MAX);
    const author = quotable(message.author ?? '', words.someone);
    return {
      text: excerpt === '' ? author : `${author}: “${excerpt}”`,
      url: `${head.appUrl}/w/${encodeURIComponent(workspace.slug)}/c/${conversation.channelId}?message=${message.id}`,
    };
  });
  return {
    kind: 'group',
    title: `${nameOf(conversation, words)} — ${words.count(messages.length)}`,
    items,
    ...(messages.length > shown.length ? { more: words.more(messages.length - shown.length) } : {}),
  };
};

const blocksOf = (head: MissedLetterHead, words: Words): LetterBlock[] => [
  { kind: 'paragraph', text: words.intro },
  ...head.workspaces.flatMap((workspace): LetterBlock[] => [
    { kind: 'heading', text: quotable(workspace.name, words.workspace) },
    ...workspace.conversations.map((conversation) =>
      conversationBlock(conversation, workspace, head, words),
    ),
  ]),
  { kind: 'button', label: words.open, url: head.appUrl },
  { kind: 'note', text: words.why },
  { kind: 'note', text: words.stop, url: `${head.appUrl}/mail/stop#${head.stopToken}` },
];

export const missedLetter = (head: MissedLetterHead): MailMessage =>
  composeLetter({
    to: head.to,
    subject: WORDS[head.locale].subject,
    locale: head.locale,
    blocks: blocksOf(head, WORDS[head.locale]),
  });
