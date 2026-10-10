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
 * The clamp is `max-h-code` (a token) with `overflow-hidden`: a block over twelve lines is
 * never taller than the feed can use, and the person opens it when they want all of it.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { useContentPorts } from './content-ports';
import type { HighlightToken } from './highlight';

/** The line count above which a block is clamped (`ARCHITECTURE.md` §8.2). */
export const CLAMP_ABOVE_LINES = 12;

const lineCount = (code: string): number => (code === '' ? 0 : code.split('\n').length);

const Tokens = ({
  lines,
}: {
  readonly lines: readonly (readonly HighlightToken[])[];
}): React.JSX.Element => (
  <>
    {lines.map((line, row) => (
      // Lines have no identity beyond their position: the text never reorders.
      <span key={row}>
        {line.map((token, column) => (
          <span
            key={column}
            style={token.color === null ? undefined : { color: token.color }}
            className={token.bold ? 'font-semibold' : token.italic ? 'italic' : undefined}
          >
            {token.content}
          </span>
        ))}
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
    <figure className="my-1 flex flex-col overflow-hidden rounded-md border-hairline border-border-subtle bg-code-bg">
      <figcaption className="flex items-center gap-3 border-b-hairline border-border-subtle px-3 py-1 text-caption text-ink-muted">
        <span className="font-mono">{language === '' ? t('message.code.plain') : language}</span>
        <span>{t('message.code.lines', { count })}</span>
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 rounded-sm text-ink-muted hover:text-ink"
        >
          <Icon name="copy" size="sm" />
          <span>{t('message.code.copy')}</span>
        </button>
      </figcaption>
      <pre
        // A scrollable region is a tab stop, or a keyboard cannot reach what overflows it.
        // The clamp hides rather than scrolls, so it takes none.
        tabIndex={clamped ? undefined : 0}
        aria-label={`${language === '' ? t('message.code.plain') : language}, ${t('message.code.lines', { count })}`}
        className={cn(
          'overflow-x-auto px-3 py-2 text-code text-ink',
          clamped && 'max-h-code overflow-y-hidden',
        )}
      >
        <code>{lines === null ? code : <Tokens lines={lines} />}</code>
      </pre>
      {count > CLAMP_ABOVE_LINES && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex items-center gap-1 border-t-hairline border-border-subtle px-3 py-1 text-caption text-ink-muted hover:text-ink"
        >
          <Icon name={open ? 'collapse' : 'expand'} size="sm" />
          {open ? t('message.code.collapse') : t('message.code.expand', { count })}
        </button>
      )}
    </figure>
  );
};
