/**
 * A message's body, as React nodes (D-98 §4).
 *
 * One function, `renderContent`, which the Phase 1 markdown renderer replaces without
 * touching a caller (O-6). It turns `parseContent`'s data into elements and nothing else:
 * **no `dangerouslySetInnerHTML`, ever** — a body is characters, so there is no HTML in it
 * to be wrong about — and the only attribute taken from the message is a link's `href`,
 * which the parser has already reduced to an `http(s)` address.
 *
 * Text keeps its line breaks and wraps (`whitespace-pre-wrap`, `break-words`): a long
 * unbroken string must wrap inside the column, not push it wider (`UX.md` §9, text that
 * overflows is a defect). A mention is highlighted only if it is one the server resolved
 * (`mentioned`, lower-case usernames); an `@name` that names nobody is just text.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { CodeBlock } from './code-block';
import { parseContent, type Block, type Inline } from './parse-content';

/**
 * Bidirectional controls: the embeddings, overrides and isolates (U+202A–202E, U+2066–2069).
 * In a link's *label* they can reorder what is drawn so that the text reads as one address
 * and the link goes to another — the label is the only thing a person checks before
 * clicking. Stripped from the label; the href is untouched, and is shown as the host in the
 * link's `title`.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** The host a link goes to; null for an address that is not a URL (it is not rendered as a link then either). */
const hostOf = (href: string): string | null => {
  try {
    return new URL(href).host;
  } catch {
    return null;
  }
};

const ExternalLink = ({
  href,
  label,
}: {
  readonly href: string;
  readonly label: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const host = hostOf(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={host === null ? undefined : t('message.link.opens', { host })}
      className="break-all text-accent underline"
    >
      {/* Isolated and left-to-right: whatever the label says, it cannot reorder the text around it. */}
      <bdi dir="ltr">{label.replace(BIDI_CONTROLS, '')}</bdi>
      <VisuallyHidden>{` (${t('message.link.external')})`}</VisuallyHidden>
    </a>
  );
};

const InlineNode = ({
  piece,
  mentioned,
}: {
  readonly piece: Inline;
  readonly mentioned: ReadonlySet<string>;
}): React.ReactNode => {
  switch (piece.kind) {
    case 'text':
      return piece.value;
    case 'code':
      return (
        <code className="rounded-sm border-hairline border-border-subtle bg-code-bg px-1 text-code">
          {piece.value}
        </code>
      );
    case 'link':
      return <ExternalLink href={piece.href} label={piece.label} />;
    case 'mention':
      return mentioned.has(piece.name.toLowerCase()) ? (
        <span className="font-medium text-accent">{piece.raw}</span>
      ) : (
        piece.raw
      );
  }
};

const BlockNode = ({
  block,
  mentioned,
}: {
  readonly block: Block;
  readonly mentioned: ReadonlySet<string>;
}): React.JSX.Element => {
  if (block.kind === 'fence') return <CodeBlock code={block.code} language={block.language} />;
  return (
    <p className="whitespace-pre-wrap break-words">
      {block.inline.map((piece, index) => (
        // A body is parsed whole and never reordered, so a position is its identity.
        <InlineNode key={index} piece={piece} mentioned={mentioned} />
      ))}
    </p>
  );
};

export interface RenderOptions {
  /** Lower-case usernames of the people this message really mentions. */
  readonly mentioned?: ReadonlySet<string>;
}

const NOBODY: ReadonlySet<string> = new Set();

export const renderContent = (
  content: string,
  { mentioned = NOBODY }: RenderOptions = {},
): React.JSX.Element => (
  <div className="flex min-w-0 flex-col gap-1 text-body text-ink">
    {parseContent(content).map((block, index) => (
      <BlockNode key={index} block={block} mentioned={mentioned} />
    ))}
  </div>
);
