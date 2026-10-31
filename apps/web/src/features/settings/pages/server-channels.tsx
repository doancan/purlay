/**
 * Administration → Server's two ways in: GitHub's app and the mail relay (D-179 §4.8). Each is tried
 * with what is typed before anything is kept — one call, which the server answers with the try's
 * outcome, in the wizard's own words per reason — and each can be disconnected, after a question that
 * says so when it is the last way in. A secret is never shown; a secret the key could not open says so
 * on its card.
 */
import { EMAIL_MAX, GITHUB_CLIENT_ID_MAX, GITHUB_CLIENT_SECRET_MAX } from '@purlay/types';
import type { ProbeResult, ServerSettingsAnswer } from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { REASONS } from '../../setup/errors';
import { CopyField, MailServerField, Note, ProbeFailure } from '../../setup/parts';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';
import { useServerClient } from '../server-context';
import { ChangeFailure, DisconnectDialog, Inset, Reveal, useRefresh } from '../server-parts';
import { Checkbox } from '../../../ui/checkbox';

/** What became of the last change, in words: shown quiet when it went well. */
type Outcome = { readonly ok: boolean; readonly words: string } | null;

export const GitHubCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const github = view.settings.github;
  const lost = view.needsReentry.includes('github');
  const [open, setOpen] = useState(false);
  const editing = open || lost;
  const [clientId, setClientId] = useState(github?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState(false);

  const failed = result !== null && !result.ok ? result : null;
  const field = failed === null ? null : REASONS[failed.reason].field;
  const filled = clientId.trim() !== '' && clientSecret.trim() !== '';

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      const value = await client.github({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setResult(value);
      if (value.ok) {
        setClientSecret('');
        setOpen(false);
        setOutcome({ ok: true, words: t('settings.server.github.saved') });
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
      title={t('settings.server.github.title')}
      description={t('settings.server.github.description')}
      footer={outcome === null ? undefined : <SaveOutcome outcome={outcome} />}
    >
      {lost && (
        <Inset>
          <Note tone="warn">{t('settings.server.reentry')}</Note>
        </Inset>
      )}
      <SettingsRow label={t('settings.server.status')}>
        {github === null ? (
          <span className="text-label font-normal text-ink-muted">
            {t('settings.server.notConnected')}
          </span>
        ) : (
          <span className="flex flex-col items-end gap-1 max-narrow:items-start">
            <span className="text-label text-ink">{t('settings.server.connected')}</span>
            <span className="font-mono text-caption text-ink-muted">
              {t('settings.server.github.clientId', { id: github.clientId })}
            </span>
          </span>
        )}
      </SettingsRow>
      {github === null && !lost && (
        <Inset>
          <p className="text-label font-normal text-ink-muted">
            {t('settings.server.github.empty')}
          </p>
        </Inset>
      )}
      <SettingsRow
        label={t('settings.server.github.callback')}
        description={t('settings.server.github.callbackHint')}
        wide
      >
        <CopyField label={t('settings.server.github.callback')} value={view.githubCallbackUrl} />
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
                label={t('setup.github.clientId')}
                value={clientId}
                autoComplete="off"
                spellCheck={false}
                maxLength={GITHUB_CLIENT_ID_MAX}
                className="font-mono"
                invalid={field === 'clientId'}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setResult(null);
                }}
              />
              <TextField
                label={t('setup.github.clientSecret')}
                type="password"
                value={clientSecret}
                autoComplete="off"
                spellCheck={false}
                maxLength={GITHUB_CLIENT_SECRET_MAX}
                className="font-mono"
                hint={t('settings.server.github.hint')}
                invalid={field === 'clientSecret'}
                onChange={(event) => {
                  setClientSecret(event.target.value);
                  setResult(null);
                }}
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
            variant={github === null ? 'primary' : 'secondary'}
            onClick={() => {
              setOpen(true);
              setOutcome(null);
            }}
          >
            {github === null
              ? t('settings.server.github.connect')
              : t('settings.server.github.replace')}
          </Button>
          {github !== null && (
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
        channel="github"
        view={view}
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.server.github.disconnectTitle')}
        body={t('settings.server.github.disconnectBody')}
        done={() => {
          setOutcome({ ok: true, words: t('settings.server.github.disconnected') });
        }}
      />
    </SettingsCard>
  );
};

export const EmailCard = ({ view }: { readonly view: ServerSettingsAnswer }): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const smtp = view.settings.smtp;
  const lost = view.needsReentry.includes('smtp');
  const [open, setOpen] = useState(false);
  const editing = open || lost;
  const [smtpUrl, setSmtpUrl] = useState('');
  const [from, setFrom] = useState(smtp?.from ?? '');
  const [allowPlaintext, setAllowPlaintext] = useState(smtp?.allowPlaintext ?? false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [asking, setAsking] = useState(false);

  const failed = result !== null && !result.ok ? result : null;
  const field = failed === null ? null : REASONS[failed.reason].field;
  const filled = smtpUrl.trim() !== '' && from.trim() !== '';

  const save = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      const value = await client.smtp({
        smtpUrl: smtpUrl.trim(),
        from: from.trim(),
        allowPlaintext,
      });
      setResult(value);
      if (value.ok) {
        setSmtpUrl('');
        setOpen(false);
        setOutcome({ ok: true, words: t('settings.server.email.saved') });
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
      title={t('settings.server.email.title')}
      description={t('settings.server.email.description')}
      footer={outcome === null ? undefined : <SaveOutcome outcome={outcome} />}
    >
      {lost && (
        <Inset>
          <Note tone="warn">{t('settings.server.reentry')}</Note>
        </Inset>
      )}
      <SettingsRow label={t('settings.server.status')}>
        {smtp === null ? (
          <span className="text-label font-normal text-ink-muted">
            {t('settings.server.notConnected')}
          </span>
        ) : (
          <span className="flex flex-col items-end gap-1 max-narrow:items-start">
            <span className="text-label text-ink">{t('settings.server.connected')}</span>
            <span className="font-mono text-caption text-ink-muted">
              {t('settings.server.email.relay', { host: smtp.address.host })}
            </span>
          </span>
        )}
      </SettingsRow>
      {smtp !== null && (
        <SettingsRow label={t('settings.server.email.sender')}>
          <span className="text-label font-normal text-ink">{smtp.from}</span>
        </SettingsRow>
      )}
      {smtp === null && !lost && (
        <Inset>
          <p className="text-label font-normal text-ink-muted">
            {t('settings.server.email.empty')}
          </p>
        </Inset>
      )}
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
              <MailServerField
                value={smtpUrl}
                invalid={field === 'smtpUrl'}
                onChange={(value) => {
                  setSmtpUrl(value);
                  setResult(null);
                }}
              />
              <TextField
                label={t('setup.email.from')}
                hint={t('setup.email.fromHint')}
                value={from}
                autoComplete="off"
                spellCheck={false}
                maxLength={EMAIL_MAX}
                invalid={field === 'from'}
                onChange={(event) => {
                  setFrom(event.target.value);
                  setResult(null);
                }}
              />
              <label className="flex items-start gap-3">
                <Checkbox
                  checked={allowPlaintext}
                  onChange={(event) => {
                    setAllowPlaintext(event.target.checked);
                  }}
                />
                <span className="flex flex-col">
                  <span className="text-label text-ink">{t('setup.email.plaintext')}</span>
                  <span className="text-caption text-ink-muted">
                    {t('setup.email.plaintextHint')}
                  </span>
                </span>
              </label>
              <p className="text-body text-ink">
                {t('settings.server.email.testNote', { email: view.adminEmail })}
              </p>
              {failed !== null && <ProbeFailure result={failed} />}
              {failure !== null && <ChangeFailure failure={failure} />}
              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" busy={busy} disabled={!filled || busy}>
                  {failed === null ? t('settings.server.email.save') : t('setup.tryAgain')}
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
            variant={smtp === null ? 'primary' : 'secondary'}
            onClick={() => {
              setOpen(true);
              setOutcome(null);
            }}
          >
            {smtp === null
              ? t('settings.server.email.connect')
              : t('settings.server.email.replace')}
          </Button>
          {smtp !== null && (
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
        channel="smtp"
        view={view}
        open={asking}
        onOpenChange={setAsking}
        title={t('settings.server.email.disconnectTitle')}
        body={t('settings.server.email.disconnectBody')}
        done={() => {
          setOutcome({ ok: true, words: t('settings.server.email.disconnected') });
        }}
      />
    </SettingsCard>
  );
};
