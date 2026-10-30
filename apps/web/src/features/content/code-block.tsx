/**
 * A fenced block of code (`UX.md` §8.2): the language, how long it is, a way to copy
 * exactly what was written, and — above twelve lines — a clamp with a control to open it.
 *
 * **What is copied is the raw text**, not what is drawn: the tokens are only colour, and a
 * clamp only hides, so the clipboard always holds the characters that were sent.
 *
 * **Plain first, colour when it arrives.** The block renders its text at once and replaces
 * it with the same text in colour when the highlighter answers — the same lines in the same
 * font, so nothing shifts; a language it does not know, or a grammar that did not load,
 * simply stays as it was. The highlighter is the page's port (`content-ports.tsx`).
 *
 * **Line numbers** from five lines on (D-210), as every code host draws them: in a column of their own,
 * not heard (`aria-hidden`) and not selected (`select-none`), so a hand selection copies the code
 * alone — and each beside its own line, so a wrapped line keeps its number at its first row.
 *
 * The clamp is `max-h-code` (a token) with `overflow-hidden`, under a fade into the block's own
 * background (`ARCHITECTURE.md` §8.2): a block over twelve lines is never taller than the feed can
 * use, it shows that there is more, and the person opens it when they want all of it.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { Tooltip } from '../../ui/tooltip';
import { useContentPorts } from './content-ports';
import type { HighlightToken } from './highlight';

/** The line count above which a block is clamped (`ARCHITECTURE.md` §8.2). */
export const CLAMP_ABOVE_LINES = 12;

const lineCount = (code: string): number => (code === '' ? 0 : code.split('\n').length);

/** The line count from which a block numbers its lines: a short snippet is read whole without them. */
const NUMBERED_FROM_LINES = 5;

/** Each line beside its number; the line itself is the code, plain or in colour. */
const Numbered = ({ lines }: { readonly lines: readonly React.ReactNode[] }): React.JSX.Element => (
  <>
    {lines.map((line, row) => (
      // Lines have no identity beyond their position: the text never reorders.
      <span key={row} className="flex">
        <span
          aria-hidden="true"
          className="min-w-8 shrink-0 pr-3 text-right text-ink-subtle select-none"
        >
          {row + 1}
        </span>
        <span className="min-w-0 flex-1">{line}</span>
      </span>
    ))}
  </>
);

/** One highlighted line's tokens: colour, and the weight or slant a theme gives some. */
const TokenLine = ({ line }: { readonly line: readonly HighlightToken[] }): React.JSX.Element => (
  <>
    {line.map((token, column) => (
      <span
        key={column}
        style={token.color === null ? undefined : { color: token.color }}
        className={token.bold ? 'font-semibold' : token.italic ? 'italic' : undefined}
      >
        {token.content}
      </span>
    ))}
  </>
);

const Tokens = ({
  lines,
}: {
  readonly lines: readonly (readonly HighlightToken[])[];
}): React.JSX.Element => (
  <>
    {lines.map((line, row) => (
      // Lines have no identity beyond their position: the text never reorders.
      <span key={row}>
        <TokenLine line={line} />
        {row < lines.length - 1 ? '\n' : null}
      </span>
    ))}
  </>
);

interface CodeBlockProps {
  readonly code: string;
  /** What followed the fence; empty for none. */
  readonly language: string;
}

export const CodeBlock = ({ code, language }: CodeBlockProps): React.JSX.Element => {
  const { t } = useI18n();
  const { show } = useToast();
  const ports = useContentPorts();
  const [lines, setLines] = useState<readonly (readonly HighlightToken[])[] | null>(null);
  const [open, setOpen] = useState(false);
  // A long line scrolls, under a scrollbar that is always drawn; wrapped, it is all in view at once.
  const [wrapped, setWrapped] = useState(false);
  const count = lineCount(code);
  const clamped = count > CLAMP_ABOVE_LINES && !open;

  useEffect(() => {
    let current = true;
    setLines(null);
    if (language !== '') {
      void ports.highlight(code, language).then((result) => {
        if (current) setLines(result);
      });
    }
    return (): void => {
      current = false;
    };
  }, [code, language, ports]);

  const copy = (): void => {
    ports.copy(code).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        // The clipboard refuses outside a secure context or without permission: say so, and
        // leave the code on the screen to be selected by hand.
        show({ message: t('failure.copy') });
      },
    );
  };

  return (
    <figure className="my-2 flex min-w-0 max-w-full flex-col overflow-hidden rounded-xl border-hairline border-border-subtle bg-code-bg shadow-card">
      <figcaption className="flex min-h-row flex-wrap items-center gap-x-2 gap-y-1 border-b-hairline border-border-subtle bg-surface-050 pr-1 pl-3 text-caption text-ink-muted">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <span
            className="min-w-0 truncate font-mono"
            title={language === '' ? t('message.code.plain') : language}
          >
            {language === '' ? t('message.code.plain') : language}
          </span>
          <span className="shrink-0 font-mono text-ink-subtle">
            {t('message.code.lines', { count })}
          </span>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Tooltip content={t('message.code.wrap')}>
            <button
              type="button"
              aria-label={t('message.code.wrap')}
              aria-pressed={wrapped}
              onClick={() => {
                setWrapped(!wrapped);
              }}
              className={cn(
                'inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink',
                wrapped ? 'bg-surface-200 text-ink' : 'text-ink-muted',
              )}
            >
              <Icon name="wrap" size="sm" />
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={copy}
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink"
          >
            <Icon name="copy" size="sm" />
            <span>{t('message.code.copy')}</span>
          </button>
        </div>
      </figcaption>
      <div className="relative">
        <pre
          // A scrollable region is a tab stop, or a keyboard cannot reach what overflows it.
          // The clamp hides rather than scrolls, so it takes none.
          tabIndex={clamped ? undefined : 0}
          aria-label={`${language === '' ? t('message.code.plain') : language}, ${t('message.code.lines', { count })}`}
          className={cn(
            'scrollbar-thin overflow-x-auto p-3 text-code text-ink',
            wrapped && 'whitespace-pre-wrap break-words',
            clamped && 'max-h-code overflow-y-hidden',
          )}
        >
          <code>
            {count >= NUMBERED_FROM_LINES ? (
              <Numbered
                lines={
                  lines === null
                    ? code.split('\n')
                    : lines.map((line, row) => <TokenLine key={row} line={line} />)
                }
              />
            ) : lines === null ? (
              code
            ) : (
              <Tokens lines={lines} />
            )}
          </code>
        </pre>
        {clamped && (
          // The fade into the block's own background says there is more below the clamp.
          <span
            aria-hidden="true"
            data-code-fade
            className="pointer-events-none absolute inset-x-0 bottom-0 h-control bg-linear-to-b from-transparent to-code-bg"
          />
        )}
      </div>
      {count > CLAMP_ABOVE_LINES && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex h-control items-center justify-center gap-1 border-t-hairline border-border-subtle text-caption text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-050 hover:text-ink"
        >
          <Icon name={open ? 'collapse' : 'expand'} size="sm" />
          {open ? t('message.code.collapse') : t('message.code.expand', { count })}
        </button>
      )}
    </figure>
  );
};
