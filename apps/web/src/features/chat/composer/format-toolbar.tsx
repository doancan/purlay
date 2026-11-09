/**
 * The composer's formatting row: the markdown buttons and the preview toggle (D-110, D-181).
 *
 * One Tab stop for the whole row, with the arrows moving along it (the toolbar pattern); the stop is the
 * button used last. It holds no text and no caret: a button reports the markdown it stands for, and the
 * composer inserts it as the key that does the same would.
 */
import { useState } from 'react';
import type { GlyphName } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { IconButton } from '../../../ui/icon-button';
import type { KeyLabels } from '../../shortcuts/platform';
import type { MarkdownKind } from './composer-text';

/** Where the preview toggle sits in the row's order of stops, after the eleven markdown buttons. */
const PREVIEW_STOP = 11;

export interface FormatToolbarProps {
  readonly previewing: boolean;
  readonly labels: KeyLabels;
  /** The key names joined as this platform prints a chord. */
  readonly chord: (...parts: readonly string[]) => string;
  readonly onInsert: (kind: MarkdownKind) => void;
  readonly onTogglePreview: () => void;
}

/** ← → Home End along the row, round at its ends; Tab is left to leave it. */
const onToolbarKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
  const at = buttons.findIndex((button) => button === document.activeElement);
  const to =
    event.key === 'ArrowRight'
      ? (at + 1) % buttons.length
      : event.key === 'ArrowLeft'
        ? (at - 1 + buttons.length) % buttons.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : -1;
  if (at === -1 || to === -1) return;
  event.preventDefault();
  buttons[to]?.focus();
};

const Divider = (): React.JSX.Element => (
  <span aria-hidden="true" className="mx-1 h-4 border-l-hairline border-border-subtle" />
);

export const FormatToolbar = ({
  previewing,
  labels,
  chord,
  onInsert,
  onTogglePreview,
}: FormatToolbarProps): React.JSX.Element => {
  const { t } = useI18n();
  // Which button is the Tab stop: the last one used.
  const [stopAt, setStopAt] = useState(0);
  /** One button of the row: its markdown, its glyph and the key that does the same. */
  const tool = (
    slot: number,
    kind: MarkdownKind,
    label: string,
    glyph: GlyphName,
    shortcut?: string,
  ): React.JSX.Element => (
    <IconButton
      key={kind}
      label={label}
      glyph={glyph}
      {...(shortcut === undefined ? {} : { shortcut })}
      tabIndex={slot === stopAt ? 0 : -1}
      onFocus={() => {
        setStopAt(slot);
      }}
      onClick={() => {
        onInsert(kind);
      }}
    />
  );
  return (
    <div
      role="toolbar"
      aria-label={t('composer.format')}
      aria-orientation="horizontal"
      className="flex items-center px-2 pt-2"
      onKeyDown={onToolbarKey}
    >
      {/* One row on every width: on a phone it scrolls sideways instead of breaking into two, and
          the preview toggle stays where it is. */}
      <div className="flex min-w-0 flex-1 items-center overflow-x-auto p-1 scrollbar-thin">
        {tool(0, 'bold', t('composer.bold'), 'bold', chord(labels.mod, 'B'))}
        {tool(1, 'italic', t('composer.italic'), 'italic', chord(labels.mod, 'I'))}
        {tool(2, 'strike', t('composer.strike'), 'strike', chord(labels.mod, labels.shift, 'X'))}
        <Divider />
        {tool(3, 'link', t('composer.link'), 'link', chord(labels.mod, labels.shift, 'U'))}
        {tool(
          4,
          'bullets',
          t('composer.bullets'),
          'bullet-list',
          chord(labels.mod, labels.shift, '8'),
        )}
        {tool(
          5,
          'numbers',
          t('composer.numbers'),
          'numbered-list',
          chord(labels.mod, labels.shift, '7'),
        )}
        {tool(6, 'tasks', t('composer.tasks'), 'task-list')}
        {tool(7, 'quote', t('composer.quote'), 'quote', chord(labels.mod, labels.shift, '9'))}
        <Divider />
        {tool(8, 'inlineCode', t('composer.inlineCode'), 'inline-code', chord(labels.mod, 'E'))}
        {tool(
          9,
          'code',
          t('composer.codeBlock'),
          'code-block',
          chord(labels.mod, labels.alt, labels.shift, 'C'),
        )}
        {tool(10, 'table', t('composer.table'), 'table')}
      </div>
      <IconButton
        label={t('composer.preview')}
        glyph="preview"
        shortcut={chord(labels.mod, labels.shift, 'P')}
        aria-pressed={previewing}
        tabIndex={stopAt === PREVIEW_STOP ? 0 : -1}
        onFocus={() => {
          setStopAt(PREVIEW_STOP);
        }}
        className="ml-1 aria-pressed:bg-surface-200 aria-pressed:text-ink"
        onClick={onTogglePreview}
      />
    </div>
  );
};
