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
 * just text. A code reference — `src/retry.ts:14`, a commit's SHA — in prose or inline code is a link
 * into the channel's repository when the caller passes one (`codeLinksIn`, D-223); never in a fenced
 * block, whose characters are code to read and copy, and never inside a link.
 */
import { Component, lazy, Suspense, useMemo } from 'react';
import {
  codeLinksIn,
  mentionsIn,
  readMarkdown,
  SafeHref,
  type Align,
  type Block,
  type CodeContext,
  type Engine,
  type Inline,
} from '@purlay/markdown';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { CodeBlock } from './code-block';
import { readingCache } from './reading-cache';

/**
 * A diff's viewer, a chunk of its own (#687): a ```diff block is rare, and until the viewer arrives the
 * same lines are drawn as the code block they are, so nothing is ever blank.
 */
const DiffBlock = lazy(async () => ({ default: (await import('./diff-block')).DiffBlock }));

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
  /** The reader's own lower-case username: a mention of them is filled, not just coloured. */
  readonly me: string | null;
  /** The channel's repository its code references link into (D-223); null makes none. */
  readonly repository: string | null;
  readonly inLabel: boolean;
  /** The first piece here directly follows code or a link, so a name it starts with is glued to it. */
  readonly glued: boolean;
}

/** In a link's label, the characters the label is drawn with, bidirectional controls removed. */
const labelText = (value: string, scope: InlineScope): string =>
  scope.inLabel ? value.replace(BIDI_CONTROLS, '') : value;

/** A piece of a run drawn as something other than its text: a mention, or a code reference's link. */
interface Span {
  readonly start: number;
  readonly end: number;
  readonly draw: (text: string) => React.ReactNode;
}

/** A run of text with its spans drawn in place, in order; one that overlaps the one before is text. */
const withSpans = (text: string, spans: readonly Span[]): React.ReactNode[] => {
  const out: React.ReactNode[] = [];
  let from = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    if (span.start < from) continue;
    out.push(text.slice(from, span.start), span.draw(text.slice(span.start, span.end)));
    from = span.end;
  }
  out.push(text.slice(from));
  return out;
};

/**
 * The code references in a run, as links into the channel's repository (D-223): none without one, and
 * none in a link's label, which is a link already.
 */
const codeSpans = (text: string, scope: InlineScope, where: CodeContext): Span[] =>
  scope.repository === null || scope.inLabel
    ? []
    : codeLinksIn(text, scope.repository, where).map((link) => ({
        start: link.start,
        end: link.end,
        draw: (covered) => (
          <ExternalLink key={`code-${String(link.start)}`} href={link.href} codeReference>
            {covered}
          </ExternalLink>
        ),
      }));

/**
 * A run of text, with the names the server resolved highlighted where the server finds them: in the
 * prose (`proseNames`, #330) — never in a link's label, never glued to the code or link before it —
 * and its code references linked.
 */
const Prose = ({
  value,
  scope,
}: {
  readonly value: string;
  readonly scope: InlineScope;
}): React.ReactNode => {
  const text = labelText(value, scope);
  const mentions = (scope.inLabel ? [] : mentionsIn(text))
    .filter((span) => scope.mentioned.has(span.name.toLowerCase()))
    .filter((span) => !(scope.glued && span.start === 0))
    .map((span): Span => ({
      start: span.start,
      end: span.end,
      draw: (covered) => (
        <span
          key={span.start}
          data-mention=""
          data-mention-me={span.name.toLowerCase() === scope.me ? '' : undefined}
          className={
            span.name.toLowerCase() === scope.me
              ? 'rounded-sm bg-accent px-1 font-medium text-on-accent'
              : 'font-medium text-accent-text'
          }
        >
          {covered}
        </span>
      ),
    }));
  return withSpans(text, [...mentions, ...codeSpans(text, scope, 'prose')]);
};

const ExternalLink = ({
  href,
  codeReference = false,
  children,
}: {
  readonly href: SafeHref;
  /** A code reference the renderer linked (D-223), rather than a link the text wrote. */
  readonly codeReference?: boolean;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  const host = hostOf(href);
  return (
    <a
      data-code-reference={codeReference ? '' : undefined}
      href={href.href}
      target="_blank"
      rel="noopener noreferrer"
      title={host === '' ? undefined : t('message.link.opens', { host })}
      className="break-all text-accent-text underline"
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
  nodes.map((node, index) => {
    const before = nodes[index - 1];
    const glued =
      before === undefined ? scope.glued : before.type === 'inlineCode' || before.type === 'link';
    return <InlineNode key={index} node={node} scope={{ ...scope, glued }} />;
  });

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
    case 'inlineCode': {
      const value = labelText(node.value, scope);
      return (
        <code className="rounded-sm border-hairline border-border-subtle bg-code-bg px-1 text-code">
          {withSpans(value, codeSpans(value, scope, 'code'))}
        </code>
      );
    }
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
      className="scrollbar-thin my-1 max-w-full overflow-x-auto"
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
      // Bold and larger by level, as a paragraph and not a heading element: in a conversation it is not an
      // outline (D-101 §3, D-189).
      return (
        <p
          className={cn(
            TEXT,
            'font-semibold',
            node.level === 1 ? 'text-display' : node.level === 2 ? 'text-title' : 'text-heading',
          )}
        >
          <Inlines nodes={node.children} scope={scope} />
        </p>
      );
    case 'code':
      // A diff is drawn as one (D-133); any other language is a code block.
      return ['diff', 'patch'].includes((node.lang ?? '').toLowerCase()) ? (
        <Suspense
          fallback={<CodeBlock code={node.value} language={(node.lang ?? '').toLowerCase()} />}
        >
          <DiffBlock code={node.value} language={(node.lang ?? '').toLowerCase()} />
        </Suspense>
      ) : (
        <CodeBlock code={node.value} language={(node.lang ?? '').toLowerCase()} />
      );
    case 'blockquote':
      return (
        // A block of its own rather than an edge: an edge is what marked a mention, and a quote read as one.
        <blockquote className="flex gap-2 rounded-md bg-surface-050 px-3 py-2 text-ink-muted">
          <span className="mt-1 shrink-0">
            <Icon name="quote" size="sm" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <Blocks nodes={node.children} scope={scope} />
          </div>
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
  readonly me: string | null;
  readonly repository: string | null;
  readonly engine: Engine | undefined;
}

/** Readings kept for the session (#46): enough for many channels' windows, never unbounded. */
const READINGS_KEPT = 1000;

/** The real engine's readings, once per text. A test's engine is never cached: it is the test's. */
export const readBody = readingCache((text: string) => readMarkdown(text), READINGS_KEPT);

const Body = ({ content, mentioned, me, repository, engine }: BodyProps): React.JSX.Element => {
  // Read inside render, so a defect in the reading is caught by the boundary around it.
  const reading = useMemo(
    () => (engine === undefined ? readBody(content) : readMarkdown(content, engine)),
    [content, engine],
  );
  const scope = useMemo(
    () => ({ mentioned, me, repository, inLabel: false, glued: false }),
    [mentioned, me, repository],
  );
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
  /** The reader's own lower-case username, so their own name stands out from everyone else's. */
  readonly me?: string | undefined;
  /**
   * The channel's repository (`Channel.codeRepository`, D-223): code references in the words link into
   * it. Without one — none given, or null — nothing is linked that the words did not link.
   */
  readonly repository?: string | null;
  /** The engine's readings; the real one unless a test injects a failure (`readMarkdown`). */
  readonly engine?: Engine;
}

const NOBODY: ReadonlySet<string> = new Set();

export const renderContent = (
  content: string,
  { mentioned = NOBODY, me, repository = null, engine }: RenderOptions = {},
): React.JSX.Element => (
  // `overflow-x-clip`: wrapping can break between grapheme clusters but not inside one, and a
  // joiner chain of three hundred emoji is one cluster (found in a browser: the row was 4,000 px
  // wide and the feed scrolled sideways). What cannot wrap is cut off at the box, not let out of it.
  <div
    data-message-body=""
    className="flex min-w-0 flex-col gap-1 overflow-x-clip text-body text-ink"
  >
    <BodyBoundary key={content} content={content}>
      <Body
        content={content}
        mentioned={mentioned}
        me={me ?? null}
        repository={repository}
        engine={engine}
      />
    </BodyBoundary>
  </div>
);
