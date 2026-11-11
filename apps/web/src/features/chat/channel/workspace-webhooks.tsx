/** Incoming ERP/n8n messages, using the channel's existing management and current readable targets. */
import { useId, useState } from 'react';
import { useChannels } from '../../../data/queries';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Select } from '../../../ui/select';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useWorkspace } from '../../shell/workspace';
import { IncomingWebhooks } from './incoming-webhooks';
import { SettingsCard, SettingsRow } from '../../settings/page';

export const WorkspaceWebhooks = (): React.JSX.Element => {
  const { workspace } = useWorkspace();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const channels = useChannels(workspace.id);
  const id = useId();
  const [target, setTarget] = useState('');
  const targets =
    channels.data?.filter(
      (channel) => channel.type !== 'direct_message' && channel.name !== null,
    ) ?? [];
  const selected = targets.find((channel) => channel.id === target);
  return (
    <SettingsCard title={t('hooks.workspace.title')} description={t('hooks.workspace.description')}>
      <SettingsRow label={t('hooks.workspace.channel')} htmlFor={id}>
        <div className="flex w-full flex-col gap-2">
          {channels.isError && (
            <div className="flex flex-wrap items-center gap-2">
              <p role="alert" className="text-label text-danger-text">
                {describe(channels.error)}
              </p>
              <Button
                busy={channels.isFetching}
                onClick={() => {
                  void channels.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </div>
          )}
          {channels.data === undefined ? (
            !channels.isError && (
              <LoadingStatus label={t('common.loading')}>
                <Skeleton />
              </LoadingStatus>
            )
          ) : (
            <Select
              id={id}
              value={selected?.id ?? ''}
              disabled={targets.length === 0}
              onChange={(event) => {
                setTarget(event.target.value);
              }}
            >
              <option value="">{t('hooks.workspace.choose')}</option>
              {targets.map((channel) => (
                <option key={channel.id} value={channel.id}>
                  #{channel.name}
                </option>
              ))}
            </Select>
          )}
          {channels.data !== undefined && targets.length === 0 && (
            <p className="text-label text-ink-muted">{t('hooks.workspace.noChannels')}</p>
          )}
        </div>
      </SettingsRow>
      {selected !== undefined && (
        <div className="border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
          <IncomingWebhooks channel={selected} />
        </div>
      )}
    </SettingsCard>
  );
};
