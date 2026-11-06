import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { ServerPreferencesRequest, type ServerPreferences } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { TextField } from '../../ui/text-field';
import { SettingsCard } from '../settings/page';
import { ChangeFailure, Inset } from '../settings/server-parts';
import { useAdministrationClient } from './context';
import { QueryState } from './parts';

export const ServerPreferencesCard = ({
  identity = false,
}: {
  readonly identity?: boolean;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const query = useQuery({
    queryKey: ['server', 'preferences'],
    queryFn: async ({ signal }) => await client.preferences(signal),
    retry: false,
  });
  return (
    <QueryState query={query}>
      {(data) => <PreferencesForm identity={identity} current={data} />}
    </QueryState>
  );
};
const PreferencesForm = ({
  current,
  identity,
}: {
  readonly current: ServerPreferences;
  readonly identity: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useAdministrationClient();
  const queries = useQueryClient();
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(current.displayName);
  const [support, setSupport] = useState(current.supportUrl ?? '');
  const [domains, setDomains] = useState(current.allowedEmailDomains.join(', '));
  const [approval, setApproval] = useState(current.requireAccountApproval);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (dirty) return;
    setName(current.displayName);
    setSupport(current.supportUrl ?? '');
    setDomains(current.allowedEmailDomains.join(', '));
    setApproval(current.requireAccountApproval);
  }, [current, dirty]);
  const save = async (): Promise<void> => {
    if (busy) return;
    const input = identity
      ? { displayName: name.trim(), supportUrl: support.trim() || null }
      : {
          allowedEmailDomains: [
            ...new Set(
              domains
                .split(/[,\s]+/)
                .map((domain) => domain.trim().toLowerCase())
                .filter(Boolean),
            ),
          ],
          requireAccountApproval: approval,
        };
    if (!Value.Check(ServerPreferencesRequest, input)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setFailure(null);
    setSaved(false);
    setBusy(true);
    try {
      await client.savePreferences(input);
      // Keep the confirmed change if reading the server again fails.
      queries.setQueryData<ServerPreferences>(['server', 'preferences'], (before) =>
        before === undefined ? undefined : { ...before, ...input },
      );
      setDirty(false);
      setSaved(true);
      await queries.invalidateQueries({ queryKey: ['instance'] });
      await queries.invalidateQueries({ queryKey: ['server', 'audit'] });
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard
      title={t(identity ? 'admin.identity' : 'admin.admissionPolicy')}
      description={t(identity ? 'admin.identity.body' : 'admin.admissionPolicy.body')}
    >
      <Inset>
        <form
          className="flex max-w-dialog flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {identity ? (
            <>
              <TextField
                label={t('admin.identity.name')}
                value={name}
                readOnly={busy}
                maxLength={100}
                onChange={(event) => {
                  setDirty(true);
                  setSaved(false);
                  setName(event.target.value);
                }}
              />
              <TextField
                label={t('admin.identity.support')}
                hint={t('admin.identity.supportHint')}
                value={support}
                readOnly={busy}
                maxLength={2048}
                onChange={(event) => {
                  setDirty(true);
                  setSaved(false);
                  setSupport(event.target.value);
                }}
              />
            </>
          ) : (
            <>
              <TextField
                label={t('admin.domains')}
                hint={t('admin.domainsHint')}
                value={domains}
                readOnly={busy}
                onChange={(event) => {
                  setDirty(true);
                  setSaved(false);
                  setDomains(event.target.value);
                }}
              />
              <label className="flex items-start gap-3 text-body text-ink">
                <Checkbox
                  checked={approval}
                  disabled={busy}
                  onChange={(event) => {
                    setDirty(true);
                    setSaved(false);
                    setApproval(event.target.checked);
                  }}
                />
                {t('admin.approvalRequired')}
              </label>
            </>
          )}
          {invalid && (
            <p role="alert" className="text-body text-danger-text">
              {t('admin.preferencesInvalid')}
            </p>
          )}
          {failure !== null && <ChangeFailure failure={failure} />}
          {saved && (
            <p role="status" className="text-body text-ink-muted">
              {t('admin.saved')}
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy}>
            {t('admin.savePreferences')}
          </Button>
        </form>
      </Inset>
    </SettingsCard>
  );
};
