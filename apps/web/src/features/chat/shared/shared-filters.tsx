/** The same channel/person controls as search, with file kind and local calendar days. */
import { useId } from 'react';
import { Value } from '@sinclair/typebox/value';
import { SharedFilters, SharedFileType } from '@purlay/types';
import { useChannels, useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { AuthorPicker } from '../../../ui/author-picker';
import { DateField } from '../../../ui/date-field';
import { Select } from '../../../ui/select';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';

const KINDS = ['image', 'pdf', 'video', 'audio', 'other'] as const;

export const SharedControls = ({
  value,
  onChange,
}: {
  readonly value: SharedFilters;
  readonly onChange: (value: SharedFilters) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const channels = useChannels(workspace.id);
  const members = useMembers(workspace.id);
  const fromId = useId();
  const change = <K extends keyof SharedFilters>(key: K, next: SharedFilters[K]): void => {
    const input: unknown = Object.fromEntries([
      ...Object.entries(value).filter(([name]) => name !== key),
      ...(next === undefined ? [] : [[key, next]]),
    ]);
    if (Value.Check(SharedFilters, input)) onChange(input);
  };
  const chosen =
    value.senderId === undefined
      ? null
      : (members.data?.find((member) => member.user.id === value.senderId)?.user.displayName ??
        t('search.someone'));
  return (
    <details
      className="text-label text-ink"
      open={Object.keys(value).some((key) => key !== 'view' && key !== 'q') || undefined}
    >
      <summary className="w-fit cursor-pointer rounded-sm py-1 text-ink-muted hover:text-ink">
        {t('search.filters')}
      </summary>
      <div className="mt-3 grid grid-cols-2 gap-3 max-narrow:grid-cols-1">
        <label className="flex min-w-0 flex-col gap-1">
          {t('search.where')}
          <Select
            value={value.channelId ?? ''}
            onChange={(event) => {
              change('channelId', event.target.value || undefined);
            }}
          >
            <option value="">{t('search.everywhere')}</option>
            {value.channelId !== undefined &&
              !channels.data?.some((channel) => channel.id === value.channelId) && (
                <option value={value.channelId}>{t('shared.unavailableChannel')}</option>
              )}
            {(channels.data ?? []).map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.type === 'direct_message'
                  ? (channel.peer?.displayName ??
                    (channel.peers.length > 0
                      ? channel.peers.map((person) => person.displayName).join(', ')
                      : (channel.name ?? '')))
                  : `#${channel.name ?? ''}`}
              </option>
            ))}
          </Select>
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <span id={fromId}>{t('search.from')}</span>
          <AuthorPicker
            labelId={fromId}
            members={members.data ?? []}
            meId={user.id}
            value={value.senderId ?? null}
            chosenName={chosen}
            onChange={(id) => {
              change('senderId', id ?? undefined);
            }}
          />
        </div>
        {value.view === 'files' && (
          <label className="flex flex-col gap-1">
            {t('shared.fileType')}
            <Select
              value={value.type ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                change('type', Value.Check(SharedFileType, next) ? next : undefined);
              }}
            >
              <option value="">{t('shared.anyType')}</option>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`shared.type.${kind}`)}
                </option>
              ))}
            </Select>
          </label>
        )}
        <DateField
          label={t('search.since')}
          value={value.since === undefined ? '' : format.isoDay(value.since)}
          onChange={(day) => {
            change('since', day === '' ? undefined : format.dayStart(day));
          }}
        />
        <DateField
          label={t('search.until')}
          hint={t('search.dateHint')}
          value={value.until === undefined ? '' : format.isoDay(value.until)}
          onChange={(day) => {
            change('until', day === '' ? undefined : format.dayStart(day));
          }}
        />
      </div>
    </details>
  );
};
