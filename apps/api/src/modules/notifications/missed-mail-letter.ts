/**
 * The letter about what a person missed (D-240), in their language (D-41): for each workspace, each
 * conversation's count and its newest few messages — who wrote, a short plain excerpt, and the message's own
 * address in the app (D-149) — then the app, why the letter came, and the link that stops it.
 *
 * - **Other people's words, quoted safely.** Names and excerpts go through `quotable`: no line breaks, no
 *   control or direction characters, no `://` for a mail client to make a link of, and cut short. The subject
 *   is fixed text, so nothing typed reaches a header.
 * - **Only the server's addresses are links**, each on a line of its own; the HTML is the text escaped.
 */
import { excerptOf } from '@purlay/markdown';
import type { PushLocale } from '@purlay/types';
import { escapeHtml, type MailMessage } from '../../platform/mail';
import { quotable } from '../workspaces/invitation-mail';

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
    open: 'Open Purlay:',
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
    open: 'Purlay’ı aç:',
    why: 'Bunu, okumadığın doğrudan mesajlar ve bahsetmeler için e-posta istediğin için alıyorsun (Ayarlar → Bildirimler). Saatte en fazla bir tane.',
    stop: 'Bu e-postaları durdurmak için bu bağlantıyı aç:',
  },
};

/** A line of the letter: words, one of the server's addresses, or the space between two paragraphs. */
type Line =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'link'; readonly url: string }
  | { readonly kind: 'gap' };

const text = (words: string): Line => ({ kind: 'text', text: words });
const link = (url: string): Line => ({ kind: 'link', url });
const GAP: Line = { kind: 'gap' };

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

const conversationLines = (
  conversation: MissedConversation,
  workspace: MissedWorkspace,
  head: MissedLetterHead,
  words: Words,
): Line[] => {
  const { messages } = conversation;
  const shown = messages.slice(-EXCERPTS_PER_CONVERSATION);
  const lines: Line[] = [text(`${nameOf(conversation, words)} — ${words.count(messages.length)}`)];
  for (const message of shown) {
    const excerpt = quotable(excerptOf(message.content), '', EXCERPT_MAX);
    const author = quotable(message.author ?? '', words.someone);
    lines.push(text(excerpt === '' ? `  ${author}` : `  ${author}: “${excerpt}”`));
    lines.push(
      link(
        `${head.appUrl}/w/${encodeURIComponent(workspace.slug)}/c/${conversation.channelId}?message=${message.id}`,
      ),
    );
  }
  if (messages.length > shown.length) {
    lines.push(text(`  ${words.more(messages.length - shown.length)}`));
  }
  return lines;
};

const linesOf = (head: MissedLetterHead, words: Words): Line[] => [
  text(words.intro),
  ...head.workspaces.flatMap((workspace) => [
    GAP,
    text(quotable(workspace.name, words.workspace)),
    ...workspace.conversations.flatMap((conversation) =>
      conversationLines(conversation, workspace, head, words),
    ),
  ]),
  GAP,
  text(words.open),
  link(head.appUrl),
  GAP,
  text(words.why),
  text(words.stop),
  link(`${head.appUrl}/mail/stop#${head.stopToken}`),
];

const plain = (lines: readonly Line[]): string =>
  lines
    .map((line) => (line.kind === 'gap' ? '' : line.kind === 'link' ? line.url : line.text))
    .join('\n');

/** The same lines as HTML: every character escaped, a paragraph per run of lines, the addresses made links. */
const html = (lines: readonly Line[]): string => {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line.kind === 'gap') {
      paragraphs.push([]);
      continue;
    }
    const escaped =
      line.kind === 'link'
        ? `<a href="${escapeHtml(line.url)}">${escapeHtml(line.url)}</a>`
        : escapeHtml(line.text);
    paragraphs.at(-1)?.push(escaped);
  }
  return paragraphs.map((paragraph) => `<p>${paragraph.join('<br>')}</p>`).join('');
};

export const missedLetter = (head: MissedLetterHead): MailMessage => {
  const words = WORDS[head.locale];
  const lines = linesOf(head, words);
  return { to: head.to, subject: words.subject, text: plain(lines), html: html(lines) };
};
