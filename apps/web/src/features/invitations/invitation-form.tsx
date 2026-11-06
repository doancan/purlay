/** Shared invitation composer for workspace settings and the quick invite dialog (D-179 §5). */
import {
  INVITATION_EMAILS_PER_INVITER_PER_DAY,
  INVITATION_EMAILS_PER_REQUEST,
  INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
  type AuthMethods,
  type InvitationMailResult,
} from '@purlay/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Skeleton } from '../../ui/skeleton';
import { MadeLink, type Invitations } from '../settings/invitations';
import { AddressChips, sendable } from '../../ui/address-chips';

/** What became of the addresses, one sentence for each thing that happened. */
const MailOutcome = ({
  results,
}: {
  readonly results: readonly InvitationMailResult[];
}): React.JSX.Element => {
  const { t } = useI18n();
  const named = (outcome: InvitationMailResult['outcome']): string =>
    results
      .filter((result) => result.outcome === outcome)
      .map((result) => result.address)
      .join(', ');
  const queued = results.filter((result) => result.outcome === 'queued').length;
  const refusals = [
    ['invalid', t('invite.mail.invalid', { addresses: named('invalid') })],
    [
      'inviter_limit',
      t('invite.mail.inviterLimit', {
        limit: INVITATION_EMAILS_PER_INVITER_PER_DAY,
        addresses: named('inviter_limit'),
      }),
    ],
    [
      'workspace_limit',
      t('invite.mail.workspaceLimit', {
        limit: INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
        addresses: named('workspace_limit'),
      }),
    ],
    ['unavailable', t('invite.mail.unavailable', { addresses: named('unavailable') })],
  ] as const;
  return (
    <div role="status" className="flex min-w-0 flex-col gap-1 text-label break-words">
      {queued > 0 && (
        <p className="text-ink">
          {t('invite.mail.queued', { count: queued })}{' '}
          <span className="text-ink-muted">{t('invite.mail.queuedNote')}</span>
        </p>
      )}
      {refusals.map(([outcome, words]) =>
        results.some((result) => result.outcome === outcome) ? (
          <p key={outcome} className="text-danger-text">
            {words}
          </p>
        ) : null,
      )}
    </div>
  );
};

/** The addresses and the button that sends the link to them; shown only where mail can be sent. */
const MailForm = ({ invitations }: { readonly invitations: Invitations }): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [addresses, setAddresses] = useState<readonly string[]>([]);
  const valid = sendable(addresses);

  const send = async (): Promise<void> => {
    const sent = await invitations.make({ emails: valid, locale });
    // Only the addresses that were refused stay, so nothing leaves the field unsaid; the rest are
    // on their way and the sentence below says so.
    setAddresses((now) =>
      sent === undefined
        ? now
        : now.filter((address) => {
            const stored = sendable([address])[0];
            const result = sent.find((found) => found.address === stored);
            return result?.outcome !== 'queued';
          }),
    );
  };

  return (
    <div className="flex flex-col gap-3">
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
        disabled={invitations.making}
      />
      <div>
        <Button
          variant="primary"
          glyph="send"
          busy={invitations.making}
          disabled={valid.length === 0}
          onClick={() => {
            void send();
          }}
        >
          {valid.length === 0
            ? t('invite.mail.sendNone')
            : t('invite.mail.send', { count: valid.length })}
        </Button>
      </div>
      {invitations.mail !== null && <MailOutcome results={invitations.mail} />}
    </div>
  );
};

/** Mail capability failures stay visible; making a copyable link remains available throughout. */
export const InvitationForm = ({
  invitations,
  methods,
}: {
  readonly invitations: Invitations;
  readonly methods: UseQueryResult<AuthMethods>;
}): React.JSX.Element => {
  const { t } = useI18n();
  const mail = methods.data?.email === true;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {methods.isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="min-w-0 flex-1 text-label text-danger-text">
            {t('invite.mail.checkFailed')}
          </p>
          <Button
            busy={methods.isFetching}
            onClick={() => {
              void methods.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {methods.data === undefined ? (
        methods.isError ? null : (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <p className="text-label text-ink-muted">{t('invite.mail.checking')}</p>
            <Skeleton className="w-1/2" />
          </div>
        )
      ) : mail ? (
        <MailForm invitations={invitations} />
      ) : (
        <p className="text-label text-ink-muted">{t('invite.mail.off')}</p>
      )}
      {mail && <p className="text-label text-ink-muted">{t('invite.mail.or')}</p>}
      {invitations.link !== null && (
        <div className="flex min-w-0 flex-col gap-2">
          <MadeLink link={invitations.link} onCopy={invitations.copyLink} />
          <p className="text-caption text-ink-muted">{t('settings.invitations.newHint')}</p>
        </div>
      )}
      <div className="flex flex-col items-start gap-2">
        <Button
          variant={mail || invitations.link !== null ? 'secondary' : 'primary'}
          glyph="invite"
          busy={invitations.making}
          onClick={() => {
            void invitations.make();
          }}
        >
          {t(invitations.link === null ? 'invite.admin.make' : 'invite.admin.makeAnother')}
        </Button>
        {invitations.link !== null && (
          <p className="text-caption text-ink-muted">{t('invite.admin.previousOpen')}</p>
        )}
      </div>
      {invitations.problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {invitations.problem}
        </p>
      )}
    </div>
  );
};
