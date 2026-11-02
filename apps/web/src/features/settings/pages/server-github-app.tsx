/**
 * Administration → Server's GitHub App (D-246): the App issues are written through — its id, slug and client,
 * its private key and its webhook secret — tried as its client and as itself before anything is kept, in the
 * words the wizard uses for a try. The two addresses GitHub's App settings must point at are shown to copy.
 * Not a way in: disconnecting it asks once, says what stays, and needs no other confirmation. Without it the
 * workspaces offer nothing of GitHub issues.
 */
import {
  GITHUB_APP_CLIENT_ID_MAX,
  GITHUB_APP_CLIENT_SECRET_MAX,
  GITHUB_APP_PRIVATE_KEY_MAX,
  GITHUB_APP_WEBHOOK_SECRET_MAX,
  type ProbeResult,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { useId, useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { reasonWords } from '../../setup/errors';
import { CopyField, Note, ProbeFailure } from '../../setup/parts';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';
import { useServerClient } from '../server-context';
import { ChangeFailure, Inset, Reveal, useRefresh } from '../server-parts';

type Outcome = { readonly ok: boolean; readonly words: string } | null;

const EMPTY = {
  appId: '',
  slug: '',
  clientId: '',
  clientSecret: '',
  privateKey: '',
  webhookSecret: '',
};

export const GitHubAppCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const keyId = useId();
  const app = view.settings.githubApp;
  const lost = view.needsReentry.includes('githubApp');
  const [open, setOpen] = useState(false);
  const editing = open || lost;
  const [form, setForm] = useState({
    ...EMPTY,
    appId: app === null ? '' : String(app.appId),
    slug: app?.slug ?? '',
    clientId: app?.clientId ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState(false);

  const failed = result !== null && !result.ok ? result : null;
  const field = failed === null ? null : reasonWords(failed.reason, undefined).field;
  const appId = Number(form.appId);
  const filled =
    Number.isSafeInteger(appId) &&
    appId > 0 &&
    Object.values(form).every((value) => value.trim() !== '');
  const change =
    (name: keyof typeof EMPTY) =>
    (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
      setForm({ ...form, [name]: event.target.value });
      setResult(null);
    };

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      const value = await client.githubApp({
        appId,
        slug: form.slug.trim(),
        clientId: form.clientId.trim(),
        clientSecret: form.clientSecret.trim(),
        privateKey: form.privateKey.trim(),
        webhookSecret: form.webhookSecret.trim(),
      });
      setResult(value);
      if (value.ok) {
        setForm({ ...form, clientSecret: '', privateKey: '', webhookSecret: '' });
        setOpen(false);
        setOutcome({ ok: true, words: t('settings.server.githubApp.saved') });
        await refresh();
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await client.disconnect('github-app', false);
      await refresh();
      setAsking(false);
      setOutcome({ ok: true, words: t('settings.server.githubApp.disconnected') });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('settings.server.githubApp.title')}
      description={t('settings.server.githubApp.description')}
      footer={outcome === null ? undefined : <SaveOutcome outcome={outcome} />}
    >
      {lost && (
        <Inset>
          <Note tone="warn">{t('settings.server.reentry')}</Note>
        </Inset>
      )}
      <SettingsRow label={t('settings.server.status')}>
        {app === null ? (
          <span className="text-label font-normal text-ink-muted">
            {t('settings.server.notConnected')}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col items-end gap-1 max-narrow:items-start">
            <span className="text-label text-ink">{t('settings.server.connected')}</span>
            <span className="max-w-full truncate font-mono text-caption text-ink-muted">
              {t('settings.server.githubApp.which', { slug: app.slug, id: String(app.appId) })}
            </span>
          </span>
        )}
      </SettingsRow>
      {app === null && !lost && (
        <Inset>
          <p className="text-label font-normal text-ink-muted">
            {t('settings.server.githubApp.empty')}
          </p>
        </Inset>
      )}
      <SettingsRow
        label={t('settings.server.githubApp.callback')}
        description={t('settings.server.githubApp.callbackHint')}
        wide
      >
        <CopyField
          label={t('settings.server.githubApp.callback')}
          value={view.githubApp.callbackUrl}
        />
      </SettingsRow>
      <SettingsRow
        label={t('settings.server.githubApp.webhook')}
        description={t('settings.server.githubApp.webhookHint')}
        wide
      >
        <CopyField
          label={t('settings.server.githubApp.webhook')}
          value={view.githubApp.webhookUrl}
        />
      </SettingsRow>
      {editing ? (
        <Inset>
          <Reveal>
            <form
              className="flex max-w-dialog flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (filled) void save();
              }}
            >
              <TextField
                label={t('settings.server.githubApp.appIdLabel')}
                value={form.appId}
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
                invalid={field === 'appId'}
                onChange={change('appId')}
              />
              <TextField
                label={t('settings.server.githubApp.slugLabel')}
                hint={t('settings.server.githubApp.slugHint')}
                value={form.slug}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                invalid={field === 'appId'}
                onChange={change('slug')}
              />
              <TextField
                label={t('settings.server.oidc.clientIdLabel')}
                value={form.clientId}
                autoComplete="off"
                spellCheck={false}
                maxLength={GITHUB_APP_CLIENT_ID_MAX}
                className="font-mono"
                invalid={field === 'clientId' || field === 'appId'}
                onChange={change('clientId')}
              />
              <TextField
                label={t('settings.server.oidc.clientSecretLabel')}
                type="password"
                value={form.clientSecret}
                autoComplete="off"
                spellCheck={false}
                maxLength={GITHUB_APP_CLIENT_SECRET_MAX}
                className="font-mono"
                invalid={field === 'clientSecret'}
                onChange={change('clientSecret')}
              />
              <div className="flex flex-col gap-1">
                <label htmlFor={keyId} className="text-label font-medium text-ink">
                  {t('settings.server.githubApp.keyLabel')}
                </label>
                <textarea
                  id={keyId}
                  rows={5}
                  value={form.privateKey}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={GITHUB_APP_PRIVATE_KEY_MAX}
                  aria-invalid={field === 'privateKey' ? true : undefined}
                  aria-describedby={`${keyId}-hint`}
                  className="w-full resize-y rounded-md border-hairline border-border-strong bg-surface-100 px-3 py-2 font-mono text-caption text-ink aria-invalid:border-danger"
                  onChange={change('privateKey')}
                />
                <p id={`${keyId}-hint`} className="text-caption text-ink-muted">
                  {t('settings.server.githubApp.keyHint')}
                </p>
              </div>
              <TextField
                label={t('settings.server.githubApp.webhookSecretLabel')}
                type="password"
                value={form.webhookSecret}
                autoComplete="off"
                spellCheck={false}
                maxLength={GITHUB_APP_WEBHOOK_SECRET_MAX}
                className="font-mono"
                hint={t('settings.server.githubApp.hint')}
                onChange={change('webhookSecret')}
              />
              {failed !== null && <ProbeFailure result={failed} />}
              {failure !== null && <ChangeFailure failure={failure} />}
              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" busy={busy} disabled={!filled || busy}>
                  {failed === null ? t('settings.server.github.save') : t('setup.tryAgain')}
                </Button>
                {!lost && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      setResult(null);
                      setFailure(null);
                    }}
                  >
                    {t('common.cancel')}
                  </Button>
                )}
                {lost && (
                  <Button
                    variant="dangerQuiet"
                    disabled={busy}
                    onClick={() => {
                      setAsking(true);
                    }}
                  >
                    {t('settings.server.disconnect')}
                  </Button>
                )}
              </div>
            </form>
          </Reveal>
        </Inset>
      ) : (
        <Inset className="flex-row flex-wrap items-center gap-2">
          <Button
            variant={app === null ? 'primary' : 'secondary'}
            onClick={() => {
              setOpen(true);
              setOutcome(null);
            }}
          >
            {app === null
              ? t('settings.server.githubApp.connect')
              : t('settings.server.github.replace')}
          </Button>
          {app !== null && (
            <Button
              variant="dangerQuiet"
              onClick={() => {
                setAsking(true);
              }}
            >
              {t('settings.server.disconnect')}
            </Button>
          )}
        </Inset>
      )}
      <Dialog
        open={asking}
        onOpenChange={(next) => {
          if (!busy) setAsking(next);
        }}
        title={t('settings.server.githubApp.disconnectTitle')}
        description={t('settings.server.githubApp.disconnectBody')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setAsking(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                void disconnect();
              }}
            >
              {t('settings.server.disconnect')}
            </Button>
          </>
        }
      >
        {failure !== null ? <ChangeFailure failure={failure} /> : null}
      </Dialog>
    </SettingsCard>
  );
};
