/**
 * A fenced `diff` (or `patch`) block, drawn as a diff (#80, D-133): reading a diff somebody pasted,
 * not reviewing code — review stays where the code is.
 *
 * - **Unified or split**, the reader's choice for this block, unified to begin with: one column of
 *   lines with both numbers, or the old side beside the new, each removal paired with the addition
 *   that follows it. On a narrow window there is room for one column, and only unified is offered.
 * - **Never colour alone** (`UX.md` §9): a removed line keeps its `-` and an added one its `+`, and
 *   a screen reader hears "removed" and "added". Each file is a table, its rows the lines.
 * - **What a code block does, it does too** (`code-block.tsx`): the count of what was added and
 *   removed, Copy for the raw text as it was sent, and the clamp above twelve lines.
 * - **Nothing pasted is lost**: what the parser cannot place is shown as context (`parse-diff.ts`).
 */
import { useMemo, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { CLAMP_ABOVE_LINES } from './code-block';
import { useContentPorts } from './content-ports';
import { parseDiff, splitRows, type DiffFile, type DiffLine } from './parse-diff';

type View = 'unified' | 'split';

const tone: Readonly<Record<DiffLine['kind'], string>> = {
  added: 'bg-success-subtle',
  removed: 'bg-danger-subtle',
  context: '',
};

const mark: Readonly<Record<DiffLine['kind'], string>> = { added: '+', removed: '-', context: ' ' };

const numberCell = 'w-1 select-none whitespace-nowrap px-2 text-right align-top text-ink-subtle';
const textCell = 'whitespace-pre px-2 align-top';

/** What a line is, for a screen reader: its mark is a character it would read as "minus". */
const Kind = ({ line }: { readonly line: DiffLine }): React.JSX.Element | null => {
  const { t } = useI18n();
  if (line.kind === 'context') return null;
  return (
    <VisuallyHidden>{t(line.kind === 'added' ? 'diff.added' : 'diff.removed')}</VisuallyHidden>
  );
};

const Unified = ({
  file,
  className,
}: {
  readonly file: DiffFile;
  readonly className?: string;
}): React.JSX.Element => (
  <tbody className={className}>
    {file.hunks.flatMap((hunk, at) => [
      hunk.header === null ? null : (
        <tr key={`h${String(at)}`} className="bg-surface-050 text-ink-muted">
          <td colSpan={3} className={textCell}>
            {hunk.header}
          </td>
        </tr>
      ),
      ...hunk.lines.map((line, row) => (
        <tr
          key={`${String(at)}.${String(row)}`}
          data-diff-line={line.kind}
          className={tone[line.kind]}
        >
          <td className={numberCell}>{line.oldNumber ?? ''}</td>
          <td className={numberCell}>{line.newNumber ?? ''}</td>
          <td className={textCell}>
            <Kind line={line} />
            <span aria-hidden="true" className="select-none">
              {mark[line.kind]}
            </span>
            {line.text}
          </td>
        </tr>
      )),
    ])}
  </tbody>
);

const Side = ({ line }: { readonly line: DiffLine | null }): React.JSX.Element => (
  <>
    <td className={cn(numberCell, line !== null && tone[line.kind])}>
      {line === null ? '' : ((line.kind === 'added' ? line.newNumber : line.oldNumber) ?? '')}
    </td>
    <td className={cn(textCell, 'w-1/2', line !== null && tone[line.kind])}>
      {line === null ? null : (
        <>
          <Kind line={line} />
          <span aria-hidden="true" className="select-none">
            {mark[line.kind]}
          </span>
          {line.text}
        </>
      )}
    </td>
  </>
);

const Split = ({ file }: { readonly file: DiffFile }): React.JSX.Element => (
  // A narrow window has room for one column: there it is unified, whatever was chosen.
  <tbody className="max-narrow:hidden">
    {file.hunks.flatMap((hunk, at) => [
      hunk.header === null ? null : (
        <tr key={`h${String(at)}`} className="bg-surface-050 text-ink-muted">
          <td colSpan={4} className={textCell}>
            {hunk.header}
          </td>
        </tr>
      ),
      ...splitRows(hunk.lines).map((row, index) => (
        <tr key={`${String(at)}.${String(index)}`}>
          <Side line={row.old} />
          <Side line={row.new === row.old ? null : row.new} />
        </tr>
      )),
    ])}
  </tbody>
);

export const DiffBlock = ({ code }: { readonly code: string }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { show } = useToast();
  const ports = useContentPorts();
  const diff = useMemo(() => parseDiff(code), [code]);
  const [view, setView] = useState<View>('unified');
  const [open, setOpen] = useState(false);
  const count = diff.files.reduce(
    (sum, file) => sum + file.hunks.reduce((lines, hunk) => lines + hunk.lines.length, 0),
    0,
  );
  const clamped = count > CLAMP_ABOVE_LINES && !open;

  const copy = (): void => {
    ports.copy(code).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };

  return (
    <figure className="my-2 flex flex-col overflow-hidden rounded-xl border-hairline border-border-subtle bg-code-bg shadow-card">
      <figcaption className="flex h-row items-center gap-2 border-b-hairline border-border-subtle bg-surface-050 pr-1 pl-3 text-caption text-ink-muted">
        <span className="font-mono">diff</span>
        <span className="font-mono text-success-text">{`+${format.number(diff.added)}`}</span>
        <span className="font-mono text-danger-text">{`−${format.number(diff.removed)}`}</span>
        <div role="group" aria-label={t('diff.view')} className="ml-auto flex max-narrow:hidden">
          {(['unified', 'split'] as const).map((each) => (
            <button
              key={each}
              type="button"
              aria-pressed={view === each}
              onClick={() => {
                setView(each);
              }}
              className={cn(
                'inline-flex h-6 items-center rounded-md px-2 transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink',
                view === each && 'bg-surface-200 text-ink',
              )}
            >
              {t(`diff.${each}`)}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink max-narrow:ml-auto"
        >
          <Icon name="copy" size="sm" />
          <span>{t('message.code.copy')}</span>
        </button>
      </figcaption>
      <div className="relative">
        <div
          // A scrollable region is a tab stop, or a keyboard cannot reach what overflows it.
          tabIndex={clamped ? undefined : 0}
          role="region"
          aria-label={t('diff.label', { added: diff.added, removed: diff.removed })}
          className={cn(
            'overflow-x-auto text-code text-ink',
            clamped && 'max-h-code overflow-y-hidden',
          )}
        >
          {diff.files.map((file, index) => (
            <table key={index} className="w-full border-collapse font-mono">
              {(file.oldPath !== null || file.newPath !== null) && (
                <caption className="border-b-hairline border-border-subtle px-2 py-1 text-left text-caption text-ink-muted">
                  {file.newPath ?? file.oldPath}
                </caption>
              )}
              <Unified
                file={file}
                // Split chosen: the unified lines are for a narrow window only.
                {...(view === 'split' ? { className: 'hidden max-narrow:table-row-group' } : {})}
              />
              {view === 'split' && <Split file={file} />}
            </table>
          ))}
        </div>
        {clamped && (
          <span
            aria-hidden="true"
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
