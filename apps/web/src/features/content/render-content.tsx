/**
 * A message's body, as React nodes (D-98 §4, D-101).
 *
 * One function, `renderContent`, which every caller uses and which draws the tree `readMarkdown`
 * narrowed — the same reading the server made when the message was written (`ARCHITECTURE.md`
 * §8.1). It turns that tree into elements and nothing else: **no `dangerouslySetInnerHTML`, ever** —
 * the tree holds characters and the kinds the product draws, so there is no markup in it to be wrong
 * about — and the only attribute taken from the message is a link's `href`, which is a `SafeHref`
 * the check made, and is checked again here (D-101 §9).
 *
 * A body the tree cannot hold — past a bound, the engine failing, or a defect while drawing it —
 * is shown as typed: one paragraph of the characters that were sent, with no link, code or
 * highlight, because where code is in it is not known. A failure is that body's alone; the feed
 * around it is untouched.
 *
 * Text keeps its line breaks and wraps (`whitespace-pre-wrap`, `break-words`): a long unbroken
 * string must wrap inside the column, not push it wider (`UX.md` §9, text that overflows is a
 * defect). A mention is highlighted only if it is one the server resolved (`mentioned`, lower-case
 * usernames), found with the server's own pattern (`mentionsIn`); an `@name` that names nobody is
 * just text.
 */
import { Component, useMemo } from 'react';
import {
  mentionsIn,
  readMarkdown,
  SafeHref,
  type Align,
  type Block,
  type Engine,
  type Inline,
} from '@purlay/markdown';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { CodeBlock } from './code-block';

/**
 * Bidirectional controls: the embeddings, overrides and isolates (U+202A–202E, U+2066–2069).
 * In a link's *label* they can reorder what is drawn so that the text reads as one address
 * and the link goes to another — the label is the only thing a person checks before
 * clicking. Stripped from every piece of the label; the href is untouched, and is shown as the
 * host in the link's `title`.
 */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** The host a link goes to; empty for an address with none, like `mailto:`. */
const hostOf = (href: SafeHref): string => new URL(href.href).host;

/** What the inline pieces are drawn with: who is really mentioned, and whether this is a link's label. */
interface InlineScope {
  readonly mentioned: ReadonlySet<string>;
  readonly inLabel: boolean;
}

/** In a link's label, the characters the label is drawn with, bidirectional controls removed. */
const labelText = (value: string, scope: InlineScope): string =>
  scope.inLabel ? value.replace(BIDI_CONTROLS, '') : value;

/** A run of text, with the names the server resolved highlighted where the shared pattern finds them. */
const Prose = ({
  value,
  scope,
}: {
  readonly value: string;
  readonly scope: InlineScope;
}): React.ReactNode => {
  const text = labelText(value, scope);
  const out: React.ReactNode[] = [];
  let from = 0;
  for (const span of mentionsIn(text)) {
    if (!scope.mentioned.has(span.name.toLowerCase())) continue;
    out.push(
      text.slice(from, span.start),
      <span key={span.start} className="font-medium text-accent">
        {text.slice(span.start, span.end)}
      </span>,
    );
    from = span.end;
  }
  out.push(text.slice(from));
  return out;
};

const ExternalLink = ({
  href,
  children,
}: {
  readonly href: SafeHref;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  const host = hostOf(href);
  return (
    <a
      href={href.href}
      target="_blank"
      rel="noopener noreferrer"
      title={host === '' ? undefined : t('message.link.opens', { host })}
      className="break-all text-accent underline"
    >
      {/* Isolated and left-to-right: whatever the label says, it cannot reorder the text around it. */}
      <bdi dir="ltr">{children}</bdi>
      <VisuallyHidden>{` (${t('message.link.external')})`}</VisuallyHidden>
    </a>
  );
};

const Inlines = ({
  nodes,
  scope,
}: {
  readonly nodes: readonly Inline[];
  readonly scope: InlineScope;
}): React.ReactNode =>
  // A body is read whole and never reordered, so a position is its identity.
  nodes.map((node, index) => <InlineNode key={index} node={node} scope={scope} />);

const InlineNode = ({
  node,
  scope,
}: {
  readonly node: Inline;
  readonly scope: InlineScope;
}): React.ReactNode => {
  switch (node.type) {
    case 'text':
      return <Prose value={node.value} scope={scope} />;
    case 'inlineCode':
      return (
        <code className="rounded-sm border-hairline border-border-subtle bg-code-bg px-1 text-code">
          {labelText(node.value, scope)}
        </code>
      );
    case 'emphasis':
      return (
        <em>
          <Inlines nodes={node.children} scope={scope} />
        </em>
      );
    case 'strong':
      return (
        <strong className="font-semibold">
          <Inlines nodes={node.children} scope={scope} />
        </strong>
      );
    case 'delete':
      return (
        <del>
          <Inlines nodes={node.children} scope={scope} />
        </del>
      );
    case 'break':
      return <br />;
    case 'link': {
      const label = <Inlines nodes={node.children} scope={{ ...scope, inLabel: true }} />;
      // The type says the check made it; a cast somewhere could still lie, and this is where an
      // address reaches the page. One that fails is a defect: thrown, so the body is shown as typed
      // and the boundary reports it, rather than quietly drawn as its label.
      if (!(node.url instanceof SafeHref)) {
        throw new TypeError('a link whose address was not checked reached the renderer');
      }
      return <ExternalLink href={node.url}>{label}</ExternalLink>;
    }
  }
};

const ALIGN: Record<NonNullable<Align>, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};
const alignOf = (align: Align | undefined): string | undefined =>
  align === null || align === undefined ? undefined : ALIGN[align];

const Table = ({
  block,
  scope,
}: {
  readonly block: Extract<Block, { type: 'table' }>;
  readonly scope: InlineScope;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [head, ...rows] = block.children;
  const cell = 'border-hairline border-border-subtle px-2 py-1';
  return (
    // A table wider than the column scrolls inside its box, which is then a tab stop, or a
    // keyboard cannot reach what overflows it — as a code block's is.
    <div
      role="group"
      aria-label={t('message.table')}
      tabIndex={0}
      className="my-1 max-w-full overflow-x-auto"
    >
      <table className="border-collapse">
        {head !== undefined && (
          <thead>
            <tr>
              {head.children.map((header, column) => (
                <th
                  key={column}
                  scope="col"
                  className={cn(cell, 'font-semibold', alignOf(block.align[column]))}
                >
                  <Inlines nodes={header.children} scope={scope} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.children.map((value, column) => (
                <td key={column} className={cn(cell, alignOf(block.align[column]))}>
                  <Inlines nodes={value.children} scope={scope} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Blocks = ({
  nodes,
  scope,
}: {
  readonly nodes: readonly Block[];
  readonly scope: InlineScope;
}): React.ReactNode =>
  nodes.map((node, index) => <BlockNode key={index} node={node} scope={scope} />);

const TEXT = 'whitespace-pre-wrap break-words';

const BlockNode = ({
  node,
  scope,
}: {
  readonly node: Block;
  readonly scope: InlineScope;
}): React.ReactNode => {
  const { t } = useI18n();
  switch (node.type) {
    case 'paragraph':
      return (
        <p className={TEXT}>
          <Inlines nodes={node.children} scope={scope} />
        </p>
      );
    case 'heading':
      // Emphasis at the body's size, not a title: a heading in a conversation is not an outline (D-101 §3).
      return (
        <p className={cn(TEXT, 'font-semibold')}>
          <Inlines nodes={node.children} scope={scope} />
        </p>
      );
    case 'code':
      return <CodeBlock code={node.value} language={(node.lang ?? '').toLowerCase()} />;
    case 'blockquote':
      return (
        <blockquote className="flex flex-col gap-1 border-l-marker border-border-strong pl-3 text-ink-muted">
          <Blocks nodes={node.children} scope={scope} />
        </blockquote>
      );
    case 'list': {
      const items = node.children.map((item, index) =>
        item.checked === null ? (
          <li key={index}>
            <Blocks nodes={item.children} scope={scope} />
          </li>
        ) : (
          // The item stays a list item, so a numbered list keeps its number; the box sits inside it.
          <li key={index}>
            <div className="flex items-baseline gap-2">
              <Icon
                name={item.checked ? 'task-done' : 'task-open'}
                size="sm"
                label={item.checked ? t('message.task.done') : t('message.task.open')}
              />
              <div className="min-w-0">
                <Blocks nodes={item.children} scope={scope} />
              </div>
            </div>
          </li>
        ),
      );
      return node.ordered ? (
        <ol start={node.start} className="list-decimal pl-5">
          {items}
        </ol>
      ) : (
        <ul className="list-disc pl-5">{items}</ul>
      );
    }
    case 'table':
      return <Table block={node} scope={scope} />;
    case 'thematicBreak':
      return <hr className="my-1 border-t-hairline border-border-subtle" />;
  }
};

/** Why a body is shown as typed: a bound it passed (D-101 §5), or a failure while reading or drawing it. */
type AsTypedReason = 'nesting' | 'delimiters' | 'run' | 'depth' | 'failed';

const AsTyped = ({
  content,
  reason,
}: {
  readonly content: string;
  readonly reason: AsTypedReason;
}): React.JSX.Element => (
  <p data-as-typed={reason} className={TEXT}>
    {content}
  </p>
);

interface BodyProps {
  readonly content: string;
  readonly mentioned: ReadonlySet<string>;
  readonly engine: Engine | undefined;
}

const Body = ({ content, mentioned, engine }: BodyProps): React.JSX.Element => {
  // Read inside render, so a defect in the reading is caught by the boundary around it.
  const reading = useMemo(() => readMarkdown(content, engine), [content, engine]);
  const scope = useMemo(() => ({ mentioned, inLabel: false }), [mentioned]);
  // The engine failing inside the bounds is a gap in them (D-101 §8): thrown to the boundary, which
  // shows the body as typed and has React report the cause, never silently drawn as text.
  if (reading.tree === null && reading.reason === 'engine') throw reading.error;
  return reading.tree === null ? (
    <AsTyped content={content} reason={reading.reason} />
  ) : (
    <>
      <Blocks nodes={reading.tree.children} scope={scope} />
    </>
  );
};

/**
 * One body's failure stays that body's: it is shown as typed and the feed goes on. The error is not
 * swallowed — React reports what a boundary caught to the console, the only report the client has
 * (it has no logger), and the server logs an engine failure on the same body at write time — and the
 * boundary is keyed by the content, so an edited body is drawn afresh.
 */
class BodyBoundary extends Component<
  { readonly content: string; readonly children: React.ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): React.ReactNode {
    return this.state.failed ? (
      <AsTyped content={this.props.content} reason="failed" />
    ) : (
      this.props.children
    );
  }
}

export interface RenderOptions {
  /** Lower-case usernames of the people this message really mentions. */
  readonly mentioned?: ReadonlySet<string>;
  /** The engine's readings; the real one unless a test injects a failure (`readMarkdown`). */
  readonly engine?: Engine;
}

const NOBODY: ReadonlySet<string> = new Set();

export const renderContent = (
  content: string,
  { mentioned = NOBODY, engine }: RenderOptions = {},
): React.JSX.Element => (
  // `overflow-x-clip`: wrapping can break between grapheme clusters but not inside one, and a
  // joiner chain of three hundred emoji is one cluster (found in a browser: the row was 4,000 px
  // wide and the feed scrolled sideways). What cannot wrap is cut off at the box, not let out of it.
  <div
    data-message-body=""
    className="flex min-w-0 flex-col gap-1 overflow-x-clip text-body text-ink"
  >
    <BodyBoundary key={content} content={content}>
      <Body content={content} mentioned={mentioned} engine={engine} />
    </BodyBoundary>
  </div>
);
