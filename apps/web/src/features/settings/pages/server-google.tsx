/**
 * Administration → Server's Google (D-251): the OAuth client this server is registered as at Google. Google's
 * address is fixed, so only the client ID and secret are asked. As the other sign-in cards are: tried with what
 * is typed before anything is kept — one call, answered with the try's outcome in words per reason — and
 * disconnected after a question that says so when it is the last way in. The secret is never shown again, and
 * one the key could not open says so on the card.
 */
import {
  GOOGLE_CLIENT_ID_MAX,
  GOOGLE_CLIENT_SECRET_MAX,
  type ProbeResult,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { reasonWords } from '../../setup/errors';
import { CopyField, Note, ProbeFailure } from '../../setup/parts';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';
import { useServerClient } from '../server-context';
import { ChangeFailure, DisconnectDialog, Inset, Reveal, useRefresh } from '../server-parts';

type Outcome = { readonly ok: boolean; readonly words: string } | null;

export const GoogleCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const google = view.settings.google;
  const lost = view.needsReentry.includes('google');
  const [open, setOpen] = useState(false);
  const editing = open || lost;
  const [clientId, setClientId] = useState(google?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState(false);

  const failed = result !== null && !result.ok ? result : null;
  const field = failed === null ? null : reasonWords(failed.reason, 'google').field;
  const filled = clientId.trim() !== '' && clientSecret.trim() !== '';

  const save = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      const value = await client.google({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setResult(value);
      if (value.ok) {
        setClientSecret('');
        setOpen(false);
        setOutcome({ ok: true, words: t('settings.server.google.saved') });
        await refresh({ google: { clientId: clientId.trim(), clientSecret: { set: true } } });
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('settings.server.google.title')}
      description={t('settings.server.google.description')}
      footer={outcome === null ? undefined : <SaveOutcome outcome={outcome} />}
    >
      {lost && (
        <Inset>
          <Note tone="warn">{t('settings.server.reentry')}</Note>
        </Inset>
      )}
      <SettingsRow label={t('settings.server.status')}>
        {google === null ? (
          <span className="text-label font-normal text-ink-muted">
            {t('settings.server.notConnected')}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col items-end gap-1 max-narrow:items-start">
            <span className="text-label text-ink">{t('settings.server.connected')}</span>
            <span className="font-mono text-caption text-ink-muted">
              {t('settings.server.google.clientId', { id: google.clientId })}
            </span>
          </span>
        )}
      </SettingsRow>
      {google === null && !lost && (
        <Inset>
          <p className="text-label font-normal text-ink-muted">
            {t('settings.server.google.empty')}
          </p>
        </Inset>
      )}
      <SettingsRow
        label={t('settings.server.google.callback')}
        description={t('settings.server.google.callbackHint')}
        wide
      >
        <CopyField label={t('settings.server.google.callback')} value={view.googleCallbackUrl} />
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
                readOnly={busy}
                label={t('settings.server.google.clientIdLabel')}
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                maxLength={GOOGLE_CLIENT_ID_MAX}
                className="font-mono"
                invalid={field === 'clientId'}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setResult(null);
                }}
              />
              <TextField
                readOnly={busy}
                label={t('settings.server.google.clientSecretLabel')}
                type="password"
                value={clientSecret}
                autoComplete="off"
                spellCheck={false}
                maxLength={GOOGLE_CLIENT_SECRET_MAX}
                className="font-mono"
                hint={t('settings.server.google.hint')}
                invalid={field === 'clientSecret'}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setResult(null);
                }}
              />
              <p className="text-caption text-ink-muted">
                {t('settings.server.google.verifiedNote')}
              </p>
              {failed !== null && <ProbeFailure result={failed} channel="google" />}
              {failure !== null && <ChangeFailure failure={failure} />}
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="primary" busy={busy} disabled={!filled || busy}>
                  {failed === null ? t('settings.server.google.save') : t('setup.tryAgain')}
                </Button>
                {!lost && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      setClientId(google?.clientId ?? '');
                      setClientSecret('');
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
            variant={google === null ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => {
              setClientId(google?.clientId ?? '');
              setClientSecret('');
              setResult(null);
              setFailure(null);
              setOpen(true);
              setOutcome(null);
            }}
          >
            {google === null
              ? t('settings.server.google.connect')
              : t('settings.server.google.replace')}
          </Button>
          {google !== null && (
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
      <DisconnectDialog
        channel="google"
        view={view}
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.server.google.disconnectTitle')}
        body={t('settings.server.google.disconnectBody')}
        done={() => {
          setOpen(false);
          setClientSecret('');
          setOutcome({ ok: true, words: t('settings.server.google.disconnected') });
        }}
      />
    </SettingsCard>
  );
};
