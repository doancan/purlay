/**
 * Step 7: invitations (UX §11, D-179 §4): a link to copy, and where mail is connected, addresses typed
 * as chips — the invitation routes' own two ways, made as the signed-in administrator. Skipping is as
 * good as any other way on, so the step passes either way (`POST /setup/invite`).
 */
import { INVITATION_EMAILS_PER_REQUEST, type InvitationMailResult } from '@purlay/types';
import { useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { AddressChips, sendable } from '../../sidebar/address-chips';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, CopyField, FailureNote, Note, StepHeader } from '../parts';
import type { StepProps } from './props';

export const InviteStep = ({ state, onBack }: StepProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const api = useApi();
  const { client, refresh, lose } = useSetup();
  const [link, setLink] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<readonly string[]>([]);
  const [results, setResults] = useState<readonly InvitationMailResult[] | null>(null);
  const [busy, setBusy] = useState<'link' | 'mail' | 'go' | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const workspaceId = state.workspace?.id ?? null;
  const valid = sendable(addresses);

  const make = async (mail: boolean): Promise<void> => {
    if (workspaceId === null) return;
    setBusy(mail ? 'mail' : 'link');
    setFailure(null);
    try {
      const made = await api.createInvitation(
        workspaceId,
        mail ? { emails: valid, locale } : undefined,
      );
      setLink(`${window.location.origin}/invite#${made.token}`);
      if (mail) {
        const sent = made.mail ?? [];
        setResults(sent);
        // What was refused stays in the field, so nothing leaves it unsaid.
        setAddresses((now) =>
          now.filter((one) => {
            const stored = sendable([one])[0];
            return sent.find((found) => found.address === stored)?.outcome !== 'queued';
          }),
        );
      }
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const go = async (): Promise<void> => {
    setBusy('go');
    setFailure(null);
    try {
      await client.invite();
      await refresh();
    } catch (caught) {
      setFailure(caught);
      if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
    } finally {
      setBusy(null);
    }
  };

  const queued = results?.filter((one) => one.outcome === 'queued').length ?? 0;
  const refused =
    results?.filter((one) => one.outcome !== 'queued').map((one) => one.address) ?? [];

  return (
    <div className="flex flex-col gap-6">
      <StepHeader title={t('setup.invite.title')} lede={t('setup.invite.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        {link === null ? (
          <div>
            <Button
              busy={busy === 'link'}
              disabled={workspaceId === null || busy !== null}
              onClick={() => {
                void make(false);
              }}
            >
              {t('setup.invite.make')}
            </Button>
          </div>
        ) : (
          <CopyField label={t('invite.admin.link')} value={link} />
        )}
        {state.channels.email && (
          <section className="flex flex-col gap-3">
            <h2 className="text-title">{t('setup.invite.mailTitle')}</h2>
            <AddressChips
              label={t('invite.mail.label')}
              hint={t('invite.mail.hint')}
              placeholder={t('invite.mail.placeholder')}
              removeLabel={(address) => t('invite.mail.remove', { address })}
              invalidLabel={t('invite.mail.invalidChip')}
              tooMany={t('invite.mail.tooMany', { max: INVITATION_EMAILS_PER_REQUEST })}
              addresses={addresses}
              onChange={setAddresses}
              max={INVITATION_EMAILS_PER_REQUEST}
              disabled={busy !== null}
            />
            <div>
              <Button
                glyph="send"
                busy={busy === 'mail'}
                disabled={valid.length === 0 || busy !== null}
                onClick={() => {
                  void make(true);
                }}
              >
                {valid.length === 0
                  ? t('invite.mail.sendNone')
                  : t('invite.mail.send', { count: valid.length })}
              </Button>
            </div>
            {queued > 0 && <Note tone="good">{t('invite.mail.queued', { count: queued })}</Note>}
            {refused.length > 0 && (
              <Note tone="warn">
                {t('setup.invite.notSent', { addresses: refused.join(', ') })}
              </Note>
            )}
          </section>
        )}
        {failure !== null && <FailureNote failure={failure} lead="setup.invite.failed" />}
      </div>
      <Actions
        start={
          onBack === null ? null : (
            <Button variant="ghost" onClick={onBack}>
              {t('setup.back')}
            </Button>
          )
        }
      >
        <Button
          variant={link === null ? 'secondary' : 'primary'}
          busy={busy === 'go'}
          disabled={busy !== null && busy !== 'go'}
          onClick={() => {
            void go();
          }}
        >
          {link === null && results === null ? t('setup.skip') : t('setup.continue')}
        </Button>
      </Actions>
    </div>
  );
};
