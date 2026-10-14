/**
 * What an edited message said before (#82, D-135): its "edited" mark opens its history — the words as
 * they are now, then each earlier version, newest first, with when it was replaced, a page at a time.
 * Anybody who can read the message reads its history; its author can take one version out, asked
 * first, in place: the remedy for words edited out that should never be read.
 *
 * A message edited before versions were kept has none, and says so. The list is read when the dialog
 * opens and again when the message changes (`MESSAGE_REVISED`, `data/cache.ts`).
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { Message, MessageVersion, MessageVersionPage } from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { codeOf, useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

const words = 'whitespace-pre-wrap break-words text-body text-ink';

const Version = ({
  version,
  mine,
  onRemove,
}: {
  readonly version: MessageVersion;
  readonly mine: boolean;
  readonly onRemove: (version: MessageVersion) => Promise<boolean>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const box = useRef<HTMLLIElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) {
      asked.current = true;
      box.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
    } else if (asked.current) {
      box.current?.querySelector<HTMLElement>('[data-ask="remove"]')?.focus();
      asked.current = false;
    }
  }, [asking]);
  return (
    <li ref={box} className="flex flex-col gap-1 border-t-hairline border-border-subtle pt-3">
      <div className="flex items-center justify-between gap-2">
        <time dateTime={version.replacedAt} className="text-caption text-ink-muted">
          {t('history.replaced', { when: format.absolute(version.replacedAt) })}
        </time>
        {mine && !asking && (
          <Button
            variant="dangerQuiet"
            data-ask="remove"
            aria-label={t('history.removeOne', { when: format.absolute(version.replacedAt) })}
            onClick={() => {
              setAsking(true);
            }}
          >
            {t('history.remove')}
          </Button>
        )}
      </div>
      <p className={words}>{version.content}</p>
      {asking && (
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
          <p id={questionId} className="text-label text-ink">
            {t('history.removeAsk')}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              data-answer="cancel"
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
                setBusy(true);
                void onRemove(version).then((done) => {
                  setBusy(false);
                  if (!done) setAsking(false);
                });
              }}
            >
              {t('history.remove')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
};

const History = ({
  message,
  mine,
}: {
  readonly message: Message;
  readonly mine: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const [problem, setProblem] = useState<string | null>(null);
  const now = useRef<HTMLHeadingElement>(null);
  const versions = useInfiniteQuery({
    queryKey: keys.messageVersions(message.id),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page: MessageVersionPage): string | undefined =>
      page.nextCursor ?? undefined,
    queryFn: async ({ pageParam, signal }) =>
      await api.messageVersions(message.id, pageParam, signal),
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.messageVersions(message.id) });
  };
  // What a failed removal said stops being true once the list is read again.
  const readAt = versions.dataUpdatedAt;
  useEffect(() => {
    setProblem(null);
  }, [readAt]);

  const remove = async (version: MessageVersion): Promise<boolean> => {
    setProblem(null);
    try {
      await api.removeMessageVersion(message.id, version.id);
    } catch (failure) {
      // Gone already is what was asked: removed from another device, or a retry after a lost answer.
      if (codeOf(failure) !== 'MESSAGE_VERSION_NOT_FOUND') {
        setProblem(`${t('history.removeFailed')} ${describe(failure)}`);
        await reread();
        return false;
      }
    }
    await reread();
    // The row the person was on is gone: their place is the history's top, never the page.
    now.current?.focus();
    return true;
  };

  const all = versions.data?.pages.flatMap((page) => page.data) ?? [];
  const failedFirst = versions.isError && versions.data === undefined;
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-1">
        <h3 ref={now} tabIndex={-1} className="text-caption text-ink-muted">
          {t('history.now')}
        </h3>
        <p className={words}>{message.content}</p>
      </section>
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
      {failedFirst ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(versions.error)}</p>
          <Button
            onClick={() => {
              void versions.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : versions.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
        </LoadingStatus>
      ) : all.length === 0 ? (
        <p className="text-body text-ink-muted">{t('history.none')}</p>
      ) : (
        <ul aria-label={t('history.earlier')} className="flex flex-col gap-3">
          {all.map((version) => (
            <Version key={version.id} version={version} mine={mine} onRemove={remove} />
          ))}
        </ul>
      )}
      {/* Older versions that failed to come: said where they would be, and the rest kept. */}
      {versions.isFetchNextPageError && (
        <p role="alert" className="text-label text-danger-text">
          {`${t('history.moreFailed')} ${describe(versions.error)}`}
        </p>
      )}
      {versions.hasNextPage && (
        <Button
          busy={versions.isFetchingNextPage}
          onClick={() => {
            void versions.fetchNextPage();
          }}
        >
          {t('history.more')}
        </Button>
      )}
    </div>
  );
};

/**
 * The "edited" mark of a message, and the history it opens. A message deleted while its history is
 * open says so there, rather than the dialog vanishing under the person; closed, the mark goes.
 */
export const EditedMark = ({
  message,
  mine,
}: {
  readonly message: Message;
  readonly mine: boolean;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const [open, setOpen] = useState(false);
  const deleted = message.deletedAt !== null;
  if (message.editedAt === null || (deleted && !open)) return null;
  return (
    <>
      <button
        type="button"
        title={format.absolute(message.editedAt)}
        aria-label={t('history.open')}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
        className="rounded-sm text-caption text-ink-subtle hover:text-ink hover:underline"
      >
        {t('message.edited')}
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('history.title')}
        description={t('history.description')}
        closeLabel={t('common.close')}
      >
        {open &&
          (deleted ? (
            <p role="status" className="text-body text-ink-muted">
              {t('message.deleted')}
            </p>
          ) : (
            <History message={message} mine={mine} />
          ))}
      </Dialog>
    </>
  );
};
