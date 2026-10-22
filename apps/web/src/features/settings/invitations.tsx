/**
 * Invitation links (D-115): making one, copying it, and the links still open with their revoking —
 * shared by the workspace menu's quick *Invite people…* dialog and the Invitations page (D-146), so
 * there is one way a link is made and one list of the open ones.
 *
 * A link's token is in the answer that makes it and never again, so a link is shown once, whole, to be
 * copied — and the list names who made each link and until when, never the link itself. Revoking is
 * immediate on the server; the list is read again after it.
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { CreateInvitationRequest, InvitationMailResult, InvitationPage } from '@purlay/types';
import { useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useWorkspace } from '../shell/workspace';

export interface Invitations {
  readonly list: UseQueryResult<InvitationPage>;
  /** The link just made, whole; null until one is made here. */
  readonly link: string | null;
  readonly making: boolean;
  readonly problem: string | null;
  /**
   * What became of each address sent with the link, in the server's words; null when none were. The
   * link is made either way, so a refusal here is never a dead end.
   */
  readonly mail: readonly InvitationMailResult[] | null;
  /** Makes the link — and, with `mail`, asks the server to send it to those addresses too. */
  readonly make: (
    mail?: CreateInvitationRequest,
  ) => Promise<readonly InvitationMailResult[] | undefined>;
  readonly revoke: (invitationId: string) => Promise<void>;
  readonly copyLink: (text: string) => void;
  /** What was made is shown once: leaving lets it go. */
  readonly forget: () => void;
}

export const useInvitations = (enabled: boolean): Invitations => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { copy } = useContentPorts();
  const { workspace } = useWorkspace();
  const [link, setLink] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [mail, setMail] = useState<readonly InvitationMailResult[] | null>(null);

  const list = useQuery({
    queryKey: keys.invitations(workspace.id),
    queryFn: async ({ signal }) => await api.invitations(workspace.id, undefined, signal),
    enabled,
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.invitations(workspace.id) });
  };

  const make = async (
    request?: CreateInvitationRequest,
  ): Promise<readonly InvitationMailResult[] | undefined> => {
    setMaking(true);
    setProblem(null);
    try {
      const made = await api.createInvitation(workspace.id, request);
      setLink(`${window.location.origin}/invite#${made.token}`);
      setMail(made.mail ?? null);
      await reread();
      return made.mail;
    } catch (failure) {
      setProblem(
        `${t(request?.emails === undefined ? 'invite.admin.makeFailed' : 'invite.mail.failed')} ${describe(failure)}`,
      );
      return undefined;
    } finally {
      setMaking(false);
    }
  };

  const revoke = async (invitationId: string): Promise<void> => {
    try {
      await api.revokeInvitation(workspace.id, invitationId);
      await reread();
    } catch (failure) {
      show({ message: `${t('invite.admin.revokeFailed')} ${describe(failure)}` });
    }
  };

  const copyLink = (text: string): void => {
    copy(text).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };

  const forget = (): void => {
    setLink(null);
    setProblem(null);
    setMail(null);
  };

  return { list, link, making, problem, mail, make, revoke, copyLink, forget };
};

/** The link just made, whole and selectable, with Copy beside it. */
export const MadeLink = ({
  link,
  onCopy,
}: {
  readonly link: string;
  readonly onCopy: (link: string) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="flex w-full items-center gap-2">
      <input
        readOnly
        value={link}
        aria-label={t('invite.admin.link')}
        className="h-control min-w-0 flex-1 rounded-md border-hairline border-border-subtle bg-surface-000 px-3 font-mono text-caption text-ink max-narrow:h-touch"
        onFocus={(event) => {
          event.target.select();
        }}
      />
      <Button
        variant="primary"
        glyph="copy"
        onClick={() => {
          onCopy(link);
        }}
      >
        {t('common.copy')}
      </Button>
    </div>
  );
};
