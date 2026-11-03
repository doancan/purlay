/**
 * Every letter the server sends, in one shape: a short note on a white page, one dark button for the
 * one thing to do, small grey words under it, signed "— Purlay", and the button's address in plain
 * at the foot for a client that shows no buttons. The same letter as plain text, block by block.
 *
 * - **Every character is escaped.** A block holds words and the server's own addresses; nothing a
 *   person typed becomes markup, and an address is only ever an `href` the letter itself chose.
 * - **Styles are inline** and the layout is tables: Gmail and Outlook drop a `<style>` block, and
 *   Outlook lays out nothing else reliably. No image is loaded: most clients block remote ones.
 * - **Light only.** The page says `color-scheme: light`, so a dark client does not invert half of it.
 */
import { escapeHtml, type MailMessage } from './mail';

type LetterLocale = 'en' | 'tr';

/** A line in a group: words, and an address in the app opened by a small link after them. */
export interface LetterItem {
  readonly text: string;
  readonly url?: string;
}

/** A part of a letter, in the order it is read. */
export type LetterBlock =
  /** A paragraph of the note. */
  | { readonly kind: 'paragraph'; readonly text: string }
  /** A heading inside the note, such as a workspace's name. */
  | { readonly kind: 'heading'; readonly text: string }
  /** A titled run of lines, such as one conversation's messages. */
  | {
      readonly kind: 'group';
      readonly title: string;
      readonly items: readonly LetterItem[];
      readonly more?: string;
    }
  /** The one thing to do. A letter has at most one, and its address is repeated at the foot. */
  | { readonly kind: 'button'; readonly label: string; readonly url: string }
  /** Small grey words — why the letter came, what to do if it was not expected — and maybe an address. */
  | { readonly kind: 'note'; readonly text: string; readonly url?: string };

export interface LetterParts {
  readonly to: string;
  readonly subject: string;
  readonly locale: LetterLocale;
  readonly blocks: readonly LetterBlock[];
}

const WORDS: Readonly<Record<LetterLocale, { open: string; fallback: string }>> = {
  en: {
    open: 'Open',
    fallback: 'If the button does not work, paste this address into your browser:',
  },
  tr: {
    open: 'Aç',
    fallback: 'Düğme çalışmazsa bu adresi tarayıcına yapıştır:',
  },
};

const SIGNATURE = '— Purlay';

const INK = '#18181b';
const MUTED = '#52525b';
const FAINT = '#71717a';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const link = (url: string, label: string, color: string): string =>
  `<a href="${escapeHtml(url)}" style="color:${color};text-decoration:underline">${escapeHtml(label)}</a>`;

const button = (label: string, url: string): string =>
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0">' +
  `<tr><td style="background:${INK};border-radius:6px">` +
  `<a href="${escapeHtml(url)}" style="display:inline-block;padding:11px 20px;font-family:${FONT};` +
  `font-size:14px;font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:6px">` +
  `${escapeHtml(label)}</a></td></tr></table>`;

const paragraph = (inner: string, style: string): string =>
  `<p style="margin:0 0 16px;${style}">${inner}</p>`;

const htmlOf = (block: LetterBlock, locale: LetterLocale): string => {
  switch (block.kind) {
    case 'paragraph':
      return paragraph(escapeHtml(block.text), `font-size:15px;line-height:24px;color:${INK}`);
    case 'heading':
      return paragraph(
        escapeHtml(block.text),
        `margin-top:24px;font-size:15px;line-height:24px;font-weight:600;color:${INK}`,
      );
    case 'group': {
      const lines = block.items.map(
        (item) =>
          escapeHtml(item.text) +
          (item.url === undefined ? '' : ` · ${link(item.url, WORDS[locale].open, INK)}`),
      );
      if (block.more !== undefined) lines.push(escapeHtml(block.more));
      return (
        paragraph(
          escapeHtml(block.title),
          `margin-bottom:4px;font-size:14px;line-height:22px;font-weight:600;color:${INK}`,
        ) + paragraph(lines.join('<br>'), `font-size:14px;line-height:22px;color:${MUTED}`)
      );
    }
    case 'button':
      return button(block.label, block.url);
    case 'note':
      return paragraph(
        escapeHtml(block.text) +
          (block.url === undefined ? '' : `<br>${link(block.url, block.url, FAINT)}`),
        `font-size:13px;line-height:20px;color:${MUTED};word-break:break-word`,
      );
  }
};

const textOf = (block: LetterBlock): string => {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return block.text;
    case 'group':
      return [
        block.title,
        ...block.items.flatMap((item) =>
          item.url === undefined ? [`  ${item.text}`] : [`  ${item.text}`, `  ${item.url}`],
        ),
        ...(block.more === undefined ? [] : [`  ${block.more}`]),
      ].join('\n');
    case 'button':
      return `${block.label}:\n${block.url}`;
    case 'note':
      return block.url === undefined ? block.text : `${block.text}\n${block.url}`;
  }
};

/** The page around the blocks: a white page, a column at most 480 pixels wide, the address at the foot. */
const page = (parts: LetterParts, body: string): string => {
  const action = parts.blocks.find((block) => block.kind === 'button');
  const foot =
    action === undefined
      ? ''
      : `<p style="margin:32px 0 0;font-size:12px;line-height:18px;color:${FAINT};word-break:break-all">` +
        `${escapeHtml(WORDS[parts.locale].fallback)}<br>${link(action.url, action.url, FAINT)}</p>`;
  return (
    `<!doctype html><html lang="${parts.locale}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(parts.subject)}</title></head>` +
    '<body style="margin:0;padding:0;background:#ffffff">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff">' +
    '<tr><td align="center" style="padding:32px 20px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px">' +
    `<tr><td style="font-family:${FONT};text-align:left">` +
    body +
    paragraph(
      escapeHtml(SIGNATURE),
      `margin-top:24px;font-size:14px;line-height:22px;color:${MUTED}`,
    ) +
    foot +
    '</td></tr></table></td></tr></table></body></html>'
  );
};

/** A letter from its blocks: the HTML page and the same words as plain text, signed. */
export const composeLetter = (parts: LetterParts): MailMessage => ({
  to: parts.to,
  subject: parts.subject,
  text: [...parts.blocks.map(textOf), SIGNATURE].join('\n\n'),
  html: page(parts, parts.blocks.map((block) => htmlOf(block, parts.locale)).join('')),
});
