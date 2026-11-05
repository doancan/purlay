/**
 * Invitation links (D-115): making one, copying it, and the links still open with their revoking —
 * shared by the workspace menu's quick *Invite people…* dialog and the Invitations page (D-146), so
 * there is one way a link is made and one list of the open ones.
 *
 * A link's token is in the answer that makes it and never again, so a link is shown once, whole, to be
 * copied — and the list names who made each link and until when, never the link itself. Revoking is
 * immediate on the server; the list is read again after it.
 */
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { CreateInvitationRequest, InvitationMailResult, InvitationPage } from '@purlay/types';
import { useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useWorkspace } from '../shell/workspace';

export interface Invitations {
  readonly list: UseInfiniteQueryResult<InfiniteData<InvitationPage>>;
  /** The link just made, whole; null until one is made here. */
  readonly link: string | null;
  readonly making: boolean;
  readonly revoking: ReadonlySet<string>;
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
  // Keep the id with the one-time secret so revoking this invitation also removes its copy field.
  const [made, setMade] = useState<{
    readonly workspaceId: string;
    readonly id: string;
    readonly link: string;
    readonly mail: readonly InvitationMailResult[] | null;
  } | null>(null);
  const [making, setMaking] = useState(false);
  const generation = useRef(0);
  const makingNow = useRef(false);
  const revokingNow = useRef(new Set<string>());
  const [revoking, setRevoking] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);

  const list = useInfiniteQuery({
    queryKey: keys.invitations(workspace.id),
    queryFn: async ({ pageParam, signal }) =>
      await api.invitations(workspace.id, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.invitations(workspace.id) });
  };

  const make = async (
    request?: CreateInvitationRequest,
  ): Promise<readonly InvitationMailResult[] | undefined> => {
    if (makingNow.current) return undefined;
    makingNow.current = true;
    const started = generation.current;
    setMaking(true);
    setProblem(null);
    setMade((current) => (current === null ? null : { ...current, mail: null }));
    try {
      const made = await api.createInvitation(workspace.id, request);
      // Closing the dialog forgets the token even if its request has not answered yet.
      if (generation.current === started) {
        setMade({
          workspaceId: workspace.id,
          id: made.invitation.id,
          link: `${window.location.origin}/invite#${made.token}`,
          mail: made.mail ?? null,
        });
      }
      await reread();
      return made.mail;
    } catch (failure) {
      if (generation.current === started) {
        setProblem(
          `${t(request?.emails === undefined ? 'invite.admin.makeFailed' : 'invite.mail.failed')} ${describe(failure)}`,
        );
      }
      return undefined;
    } finally {
      makingNow.current = false;
      setMaking(false);
    }
  };

  const revoke = async (invitationId: string): Promise<void> => {
    if (revokingNow.current.has(invitationId)) return;
    revokingNow.current.add(invitationId);
    setRevoking(new Set(revokingNow.current));
    try {
      await api.revokeInvitation(workspace.id, invitationId);
      setMade((current) => (current?.id === invitationId ? null : current));
      // A successful write is kept even if the following read fails. Do not offer the dead link again.
      await client.cancelQueries({ queryKey: keys.invitations(workspace.id) });
      client.setQueryData<InfiniteData<InvitationPage>>(
        keys.invitations(workspace.id),
        (current) =>
          current === undefined
            ? undefined
            : {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  data: page.data.filter((invitation) => invitation.id !== invitationId),
                })),
              },
      );
      show({ message: t('invite.admin.revoked') });
      await reread();
    } catch (failure) {
      show({ message: `${t('invite.admin.revokeFailed')} ${describe(failure)}` });
    } finally {
      revokingNow.current.delete(invitationId);
      setRevoking(new Set(revokingNow.current));
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
    generation.current += 1;
    setMade(null);
    setProblem(null);
  };

  const current = made?.workspaceId === workspace.id ? made : null;
  return {
    list,
    link: current?.link ?? null,
    making,
    revoking,
    problem,
    mail: current?.mail ?? null,
    make,
    revoke,
    copyLink,
    forget,
  };
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
        className="h-control min-w-0 flex-1 rounded-md border-hairline border-border-subtle bg-surface-000 px-3 font-mono text-caption text-ink max-narrow:h-touch max-narrow:text-title max-narrow:font-normal"
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
