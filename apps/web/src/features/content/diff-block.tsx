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
 * - **Nothing pasted is lost**: git's notes and prose are rows of their own (`parse-diff.ts`), and a
 *   paste with nothing to draw as a diff is drawn as a code block.
 */
import { useMemo, useState } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { CLAMP_ABOVE_LINES, CodeBlock } from './code-block';
import { useContentPorts } from './content-ports';
import { parseDiff, splitRows, type DiffFile, type DiffLine } from './parse-diff';

type View = 'unified' | 'split';

const tone: Readonly<Record<DiffLine['kind'], string>> = {
  added: 'bg-success-subtle',
  removed: 'bg-danger-subtle',
  context: '',
  note: 'text-ink-muted',
};

const mark: Readonly<Record<DiffLine['kind'], string>> = {
  added: '+',
  removed: '-',
  context: ' ',
  note: '',
};

const numberCell = 'w-1 select-none whitespace-nowrap px-2 text-right align-top text-ink-subtle';
const textCell = 'whitespace-pre px-2 align-top';

/**
 * What a line is, for a screen reader: its mark is a character it would read as "minus". Not
 * selectable, so a reader who copies lines by hand gets the lines, not the words.
 */
const Kind = ({ line }: { readonly line: DiffLine }): React.JSX.Element | null => {
  const { t } = useI18n();
  if (line.kind !== 'added' && line.kind !== 'removed') return null;
  return (
    <VisuallyHidden className="select-none">
      {t(line.kind === 'added' ? 'diff.added' : 'diff.removed')}
    </VisuallyHidden>
  );
};

/** The columns, named for a screen reader; a sighted reader sees what they are. */
const Head = ({
  split,
  className,
}: {
  readonly split: boolean;
  readonly className?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const columns = split
    ? [t('diff.oldLine'), t('diff.line'), t('diff.newLine'), t('diff.line')]
    : [t('diff.oldLine'), t('diff.newLine'), t('diff.line')];
  return (
    <thead className={cn(split && 'max-narrow:hidden', className)}>
      <tr>
        {columns.map((name, at) => (
          <th key={at} scope="col" className="p-0">
            <VisuallyHidden>{name}</VisuallyHidden>
          </th>
        ))}
      </tr>
    </thead>
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

const Side = ({
  line,
  side,
}: {
  readonly line: DiffLine | null;
  readonly side: 'old' | 'new';
}): React.JSX.Element => (
  <>
    <td className={cn(numberCell, line !== null && tone[line.kind])}>
      {line === null ? '' : ((side === 'old' ? line.oldNumber : line.newNumber) ?? '')}
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

const Split = ({ file }: { readonly file: DiffFile }): React.JSX.Element => {
  const rows = useMemo(() => file.hunks.map((hunk) => splitRows(hunk.lines)), [file]);
  return (
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
        ...(rows[at] ?? []).map((row, index) =>
          row.kind === 'note' ? (
            <tr key={`${String(at)}.${String(index)}`} data-diff-line="note">
              <td colSpan={4} className={cn(textCell, tone.note)}>
                {row.line.text}
              </td>
            </tr>
          ) : (
            <tr key={`${String(at)}.${String(index)}`}>
              <Side line={row.old} side="old" />
              <Side line={row.new} side="new" />
            </tr>
          ),
        ),
      ])}
    </tbody>
  );
};

export const DiffBlock = ({
  code,
  language,
}: {
  readonly code: string;
  readonly language: string;
}): React.JSX.Element => {
  const diff = useMemo(() => parseDiff(code), [code]);
  // Nothing to draw as a diff (an empty fence): what a code block of the same text would be.
  if (diff.files.length === 0) return <CodeBlock code={code} language={language} />;
  return <Diff code={code} diff={diff} />;
};

const Diff = ({
  code,
  diff,
}: {
  readonly code: string;
  readonly diff: ReturnType<typeof parseDiff>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { show } = useToast();
  const ports = useContentPorts();
  const [view, setView] = useState<View>('unified');
  const [open, setOpen] = useState(false);
  // The lines as pasted, as a code block counts them, so the two clamp alike.
  const count = code.split('\n').length;
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
          // What scrolls sideways on purpose, as a code block's `pre` does (`e2e/narrow.e2e.ts`).
          data-diff=""
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
              <Head
                split={false}
                {...(view === 'split' ? { className: 'hidden max-narrow:table-header-group' } : {})}
              />
              {view === 'split' && <Head split />}
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
