/** Personal navigation forms use the existing dialog, field and native select primitives. */
import { useId, useRef, useState } from 'react';
import { CHANNEL_GROUP_NAME_MAX, type Channel, type ChannelGroup } from '@purlay/types';
import { codeOf, useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { Select } from '../../../ui/select';
import { TextField } from '../../../ui/text-field';
import { useChannelGroups } from './groups-data';
import { useGroupActions } from './group-actions';

interface Door {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocus?: () => HTMLElement | null;
}

export const ChannelGroupEditor = ({
  open,
  onOpenChange,
  group = null,
  returnFocus,
}: Door & {
  readonly group?: ChannelGroup | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { save } = useGroupActions();
  const [name, setName] = useState(group?.name ?? '');
  const [id, setId] = useState(group?.id ?? crypto.randomUUID());
  const [error, setError] = useState<{
    readonly field: 'name' | 'form';
    readonly message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const form = useId();
  const change = (next: boolean): void => {
    if (!next) {
      setName(group?.name ?? '');
      setId(group?.id ?? crypto.randomUUID());
      setError(null);
    }
    onOpenChange(next);
  };
  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (pending.current) return;
    if (name.trim() === '') {
      setError({ field: 'name', message: t('channelGroups.nameRequired') });
      return;
    }
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await save(id, name);
      change(false);
    } catch (failure) {
      const code = codeOf(failure);
      setError({
        field:
          code === 'CHANNEL_GROUP_NAME_TAKEN' || code === 'VALIDATION_FAILED' ? 'name' : 'form',
        message: describe(failure),
      });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t(group === null ? 'channelGroups.create' : 'channelGroups.rename')}
      {...(returnFocus === undefined ? {} : { returnFocus })}
      description={t('channelGroups.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            onClick={() => {
              change(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={form} variant="primary" busy={busy}>
            {t(group === null ? 'channelGroups.createButton' : 'channelGroups.save')}
          </Button>
        </>
      }
    >
      <form
        id={form}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <TextField
          label={t('channelGroups.name')}
          value={name}
          maxLength={CHANNEL_GROUP_NAME_MAX}
          required
          autoComplete="off"
          {...(error?.field === 'name' ? { error: error.message } : {})}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        {error?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {error.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};

export const DeleteChannelGroupDialog = ({
  open,
  onOpenChange,
  group,
  returnFocus,
}: Door & {
  readonly group: ChannelGroup;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { remove } = useGroupActions();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const submit = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await remove(group);
      onOpenChange(false);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('channelGroups.deleteTitle', { name: group.name })}
      {...(returnFocus === undefined ? {} : { returnFocus })}
      description={t('channelGroups.deleteDescription')}
      closeLabel={t('common.close')}
      focusFirst="dialog"
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              void submit();
            }}
          >
            {t('channelGroups.delete')}
          </Button>
        </>
      }
    >
      {error !== null && (
        <p role="alert" className="text-label text-danger-text">
          {error}
        </p>
      )}
    </Dialog>
  );
};

export const MoveChannelGroupDialog = ({
  open,
  onOpenChange,
  channel,
  returnFocus,
}: Door & {
  readonly channel: Channel;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const groups = useChannelGroups();
  const { move } = useGroupActions();
  const [selected, setSelected] = useState(channel.sidebarGroupId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const field = useId();
  const submit = async (): Promise<void> => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await move(channel, selected === '' ? null : selected);
      onOpenChange(false);
    } catch (failure) {
      setError(describe(failure));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('channelGroups.moveTitle', { name: channel.name ?? '' })}
      {...(returnFocus === undefined ? {} : { returnFocus })}
      description={t('channelGroups.moveDescription')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={groups.isPending || groups.isError}
            onClick={() => {
              void submit();
            }}
          >
            {t('channelGroups.moveButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={field} className="text-label font-medium text-ink">
          {t('channelGroups.name')}
        </label>
        <Select
          id={field}
          value={selected}
          disabled={groups.isPending || groups.isError}
          onChange={(event) => {
            setSelected(event.target.value);
          }}
        >
          <option value="">{t('sidebar.channels')}</option>
          {(groups.data?.data ?? []).map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </Select>
        {groups.isPending && (
          <p role="status" className="text-caption text-ink-muted">
            {t('channelGroups.loading')}
          </p>
        )}
        {groups.isError && (
          <>
            <p role="alert" className="text-label text-danger-text">
              {t('channelGroups.loadFailed')}
            </p>
            <Button
              onClick={() => {
                void groups.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </>
        )}
        {groups.isSuccess && groups.data.data.length === 0 && (
          <p className="text-caption text-ink-muted">{t('channelGroups.createHint')}</p>
        )}
        {error !== null && (
          <p role="alert" className="text-label text-danger-text">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
};
