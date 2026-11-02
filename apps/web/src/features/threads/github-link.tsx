/**
 * Pointing a thread at GitHub work that already exists (D-246 §3): an address on GitHub, taken as it is written
 * and judged by the server — one answer says the item does not exist or cannot be reached by this person and the
 * App both. Nothing is written to GitHub and nothing is resolved. Needs the person's own authorization, since
 * their own access decides whether they may point at it; asked for here when it is missing.
 */
import { GitHubLink } from '@purlay/types';
import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { useState } from 'react';
import { useApi } from '../../data/api-provider';
import { codeOf, useDescribeFailure } from '../../data/failure';
import { isApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { threadHref } from '../../router/routes';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { Note } from '../setup/parts';
import { useWorkspace } from '../shell/workspace';
import { leave } from '../sign-in/leave';

/** What the server's `400` on `url` says, by the words it chose; any other refusal is said as it is. */
const wordsOfRefusal = (failure: unknown, t: ReturnType<typeof useI18n>['t']): string | null => {
  if (!isApiError(failure) || failure.code !== 'VALIDATION_FAILED') return null;
  return failure.message.includes('already points at')
    ? t('githubIssue.link.full')
    : t('githubIssue.link.unreachable');
};

export const GitHubLinkDialog = ({
  rootId,
  channelId,
  onClose,
}: {
  readonly rootId: string;
  readonly channelId: string;
  readonly onClose: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [words, setWords] = useState('');
  const status = useQuery({
    queryKey: keys.githubApp(workspace.id),
    queryFn: async ({ signal }) => await api.githubApp(workspace.id, signal),
  });
  const authorized = status.data?.authorization != null;
  const address = url.trim();
  // As the contract holds every GitHub link: anything else is said before it is sent.
  const wellFormed = Value.Check(GitHubLink, address);

  const link = async (): Promise<void> => {
    if (!wellFormed || busy) return;
    setBusy(true);
    setWords('');
    try {
      await api.linkGitHubWork(rootId, { url: address });
      onClose();
    } catch (failure) {
      if (codeOf(failure) === 'GITHUB_AUTHORIZATION_REQUIRED') {
        await status.refetch();
      } else {
        setWords(wordsOfRefusal(failure, t) ?? describe(failure));
      }
      setBusy(false);
    }
  };

  const authorize = async (): Promise<void> => {
    setBusy(true);
    try {
      leave.to(
        (await api.startGitHubAuthorization(threadHref(workspace.slug, channelId, rootId))).url,
      );
    } catch (failure) {
      setWords(describe(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
      title={t('githubIssue.link.title')}
      description={t('githubIssue.link.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {authorized && (
            <Button
              variant="primary"
              busy={busy}
              disabled={!wellFormed}
              onClick={() => {
                void link();
              }}
            >
              {t('githubIssue.link.action')}
            </Button>
          )}
        </>
      }
    >
      {status.isPending ? null : !authorized ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink">{t('githubIssue.authorize.body')}</p>
          <div>
            <Button
              variant="primary"
              busy={busy}
              onClick={() => {
                void authorize();
              }}
            >
              {t('githubIssue.authorize.action')}
            </Button>
          </div>
          {words !== '' && <Note tone="warn">{words}</Note>}
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void link();
          }}
        >
          <TextField
            label={t('githubIssue.link.label')}
            hint={t('githubIssue.link.hint')}
            type="url"
            value={url}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            invalid={address !== '' && !wellFormed}
            onChange={(event) => {
              setUrl(event.target.value);
              setWords('');
            }}
          />
          {address !== '' && !wellFormed && (
            <Note tone="warn">{t('githubIssue.link.invalid')}</Note>
          )}
          {words !== '' && <Note tone="warn">{words}</Note>}
        </form>
      )}
    </Dialog>
  );
};
