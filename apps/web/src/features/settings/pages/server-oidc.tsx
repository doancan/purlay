/**
 * Administration → Server's single sign-on (D-200): the organisation's OpenID Connect provider, its issuer,
 * the client this server is registered as, and the label of the sign-in button. As GitHub's card is: tried
 * with what is typed before anything is kept — one call, answered with the try's outcome in words per reason —
 * and disconnected after a question that says so when it is the last way in. The secret is never shown again,
 * and one the key could not open says so on the card.
 */
import {
  OIDC_CLIENT_ID_MAX,
  OIDC_CLIENT_SECRET_MAX,
  OIDC_ISSUER_MAX,
  OIDC_NAME_MAX,
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

export const OidcCard = ({ view }: { readonly view: ServerSettingsAnswer }): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const oidc = view.settings.oidc;
  const lost = view.needsReentry.includes('oidc');
  const [open, setOpen] = useState(false);
  const editing = open || lost;
  const [issuer, setIssuer] = useState(oidc?.issuer ?? '');
  const [clientId, setClientId] = useState(oidc?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [name, setName] = useState(oidc?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState(false);

  const failed = result !== null && !result.ok ? result : null;
  const field = failed === null ? null : reasonWords(failed.reason, 'oidc').field;
  const filled = issuer.trim() !== '' && clientId.trim() !== '' && clientSecret.trim() !== '';

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      const value = await client.oidc({
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        name: name.trim(),
      });
      setResult(value);
      if (value.ok) {
        setClientSecret('');
        setOpen(false);
        setOutcome({ ok: true, words: t('settings.server.oidc.saved') });
        await refresh();
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('settings.server.oidc.title')}
      description={t('settings.server.oidc.description')}
      footer={outcome === null ? undefined : <SaveOutcome outcome={outcome} />}
    >
      {lost && (
        <Inset>
          <Note tone="warn">{t('settings.server.reentry')}</Note>
        </Inset>
      )}
      <SettingsRow label={t('settings.server.status')}>
        {oidc === null ? (
          <span className="text-label font-normal text-ink-muted">
            {t('settings.server.notConnected')}
          </span>
        ) : (
          <span className="flex min-w-0 flex-col items-end gap-1 max-narrow:items-start">
            <span className="text-label text-ink">{t('settings.server.connected')}</span>
            <span className="max-w-full truncate font-mono text-caption text-ink-muted">
              {t('settings.server.oidc.issuer', { issuer: oidc.issuer })}
            </span>
            <span className="font-mono text-caption text-ink-muted">
              {t('settings.server.oidc.clientId', { id: oidc.clientId })}
            </span>
          </span>
        )}
      </SettingsRow>
      {oidc === null && !lost && (
        <Inset>
          <p className="text-label font-normal text-ink-muted">{t('settings.server.oidc.empty')}</p>
        </Inset>
      )}
      <SettingsRow
        label={t('settings.server.oidc.callback')}
        description={t('settings.server.oidc.callbackHint')}
        wide
      >
        <CopyField label={t('settings.server.oidc.callback')} value={view.oidcCallbackUrl} />
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
                label={t('settings.server.oidc.issuerLabel')}
                hint={t('settings.server.oidc.issuerHint')}
                value={issuer}
                type="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={OIDC_ISSUER_MAX}
                className="font-mono"
                invalid={field === 'issuer'}
                onChange={(event) => {
                  setIssuer(event.target.value);
                  setResult(null);
                }}
              />
              <TextField
                label={t('settings.server.oidc.clientIdLabel')}
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                maxLength={OIDC_CLIENT_ID_MAX}
                className="font-mono"
                invalid={field === 'clientId'}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setResult(null);
                }}
              />
              <TextField
                label={t('settings.server.oidc.clientSecretLabel')}
                type="password"
                value={clientSecret}
                autoComplete="off"
                spellCheck={false}
                maxLength={OIDC_CLIENT_SECRET_MAX}
                className="font-mono"
                hint={t('settings.server.oidc.hint')}
                invalid={field === 'clientSecret'}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setResult(null);
                }}
              />
              <TextField
                label={t('settings.server.oidc.nameLabel')}
                hint={t('settings.server.oidc.nameHint')}
                value={name}
                autoComplete="off"
                maxLength={OIDC_NAME_MAX}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
              <p className="text-caption text-ink-muted">
                {t('settings.server.oidc.verifiedNote')}
              </p>
              {failed !== null && <ProbeFailure result={failed} channel="oidc" />}
              {failure !== null && <ChangeFailure failure={failure} />}
              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" busy={busy} disabled={!filled || busy}>
                  {failed === null ? t('settings.server.oidc.save') : t('setup.tryAgain')}
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
            variant={oidc === null ? 'primary' : 'secondary'}
            onClick={() => {
              setOpen(true);
              setOutcome(null);
            }}
          >
            {oidc === null ? t('settings.server.oidc.connect') : t('settings.server.oidc.replace')}
          </Button>
          {oidc !== null && (
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
        channel="oidc"
        view={view}
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.server.oidc.disconnectTitle')}
        body={t('settings.server.oidc.disconnectBody')}
        done={() => {
          setOutcome({ ok: true, words: t('settings.server.oidc.disconnected') });
        }}
      />
    </SettingsCard>
  );
};
