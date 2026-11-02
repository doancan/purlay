/**
 * A channel's bookmarks, in a row under its header (D-218): the runbook, the dashboard, the repository —
 * one click away for everyone who can see the channel.
 *
 * - **What the server says** (`GET …/bookmarks`), kept current by `BOOKMARKS_UPDATED`. An add is shown
 *   when the server has it; a removal is taken off at once and put back if refused.
 * - **Members change it**: Add a bookmark, and × on a chip, are a member's; anyone else who can see the
 *   channel reads the row, and sees nothing at all when it is empty.
 * - **Undo** for a removal: the toast adds the same address and name back.
 * - A chip opens its address in a new tab, without telling the site where it came from.
 */
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BookmarkList, Channel, ChannelBookmark } from '@purlay/types';
import { BOOKMARK_TITLE_MAX, BOOKMARKS_MAX } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { bookmarkTitle, bookmarkUrl } from './bookmark-input';

interface Added {
  readonly url: string;
  readonly title: string;
}

const AddBookmarkDialog = ({
  channel,
  open,
  onOpenChange,
  onAdd,
}: {
  readonly channel: Channel;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onAdd: (input: Added) => Promise<void>;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const formId = useId();
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<{ field: 'url' | 'form'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (next: boolean): void => {
    if (!next) {
      setAddress('');
      setTitle('');
      setProblem(null);
      setBusy(false);
    }
    onOpenChange(next);
  };

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const url = bookmarkUrl(address);
    if (url === null) {
      setProblem({ field: 'url', message: t('bookmarks.invalidUrl') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await onAdd({ url, title: bookmarkTitle(title, url) });
      change(false);
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem({ field: 'url', message: t('bookmarks.invalidUrl') });
      } else if (isApiError(failure) && failure.code === 'BOOKMARKS_LIMIT') {
        setProblem({ field: 'form', message: t('bookmarks.full', { max: BOOKMARKS_MAX }) });
      } else {
        setProblem({ field: 'form', message: `${t('bookmarks.addFailed')} ${describe(failure)}` });
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('bookmarks.add')}
      description={t('bookmarks.addBody', { channel: channel.name ?? '' })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            onClick={() => {
              change(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            {t('bookmarks.add')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          label={t('bookmarks.url')}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={address}
          required
          autoComplete="off"
          spellCheck={false}
          {...(problem?.field === 'url' ? { error: problem.message } : {})}
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
        <TextField
          label={t('bookmarks.name')}
          hint={t('bookmarks.nameHint')}
          value={title}
          maxLength={BOOKMARK_TITLE_MAX}
          autoComplete="off"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};

const Chip = ({
  bookmark,
  onRemove,
}: {
  readonly bookmark: ChannelBookmark;
  readonly onRemove: (() => void) | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <li className="group/chip relative flex shrink-0 items-center rounded-pill border-hairline border-border-subtle bg-surface-050 transition-colors duration-hover ease-standard hover:bg-surface-200 animate-pop-in">
      <a
        href={bookmark.url}
        target="_blank"
        rel="noopener noreferrer"
        title={bookmark.url}
        className="flex max-w-field items-center gap-1 rounded-pill px-3 py-1 text-label text-ink group-hover/chip:pr-1 group-focus-within/chip:pr-1"
      >
        <Icon name="link" size="sm" />
        <span className="truncate">{bookmark.title}</span>
      </a>
      {onRemove !== null && (
        <button
          type="button"
          aria-label={t('bookmarks.removeOf', { name: bookmark.title })}
          onClick={onRemove}
          className="mr-1 hidden size-icon-md items-center justify-center rounded-pill text-ink-muted hover:text-ink focus-visible:flex group-hover/chip:flex group-focus-within/chip:flex"
        >
          <Icon name="close" size="sm" />
        </button>
      )}
    </li>
  );
};

export const BookmarkBar = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [adding, setAdding] = useState(false);
  const key = keys.bookmarks(channel.id);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => api.bookmarks(channel.id, signal),
  });
  const member = channel.state !== null;
  const bookmarks = query.data ?? [];

  const add = async (input: Added): Promise<void> => {
    const added = await api.addBookmark(channel.id, input);
    client.setQueryData<BookmarkList>(key, (held = []) =>
      held.some((each) => each.id === added.id) ? held : [...held, added],
    );
  };

  const remove = (bookmark: ChannelBookmark): void => {
    client.setQueryData<BookmarkList>(key, (held = []) =>
      held.filter((each) => each.id !== bookmark.id),
    );
    api.removeBookmark(channel.id, bookmark.id).then(
      () => {
        show({
          message: t('bookmarks.removed', { name: bookmark.title }),
          actionLabel: t('common.undo'),
          onAction: () => {
            add({ url: bookmark.url, title: bookmark.title }).catch((failure: unknown) => {
              show({ message: `${t('bookmarks.addFailed')} ${describe(failure)}` });
            });
          },
        });
      },
      (failure: unknown) => {
        // Put back as the server has it: removed by someone else meanwhile is still removed.
        void client.invalidateQueries({ queryKey: key, exact: true });
        // Already gone is what was asked for.
        if (isApiError(failure) && failure.code === 'BOOKMARK_NOT_FOUND') return;
        show({ message: `${t('bookmarks.removeFailed')} ${describe(failure)}` });
      },
    );
  };

  // Nothing to read and nothing this person may add: no row at all.
  if (query.isPending || (bookmarks.length === 0 && !member)) return null;

  return (
    <nav
      aria-label={t('bookmarks.label')}
      className="flex shrink-0 items-center gap-2 overflow-x-auto border-b-hairline border-border-subtle px-4 py-2"
    >
      {bookmarks.length > 0 && (
        <ul className="flex items-center gap-2">
          {bookmarks.map((bookmark) => (
            <Chip
              key={bookmark.id}
              bookmark={bookmark}
              onRemove={
                member
                  ? (): void => {
                      remove(bookmark);
                    }
                  : null
              }
            />
          ))}
        </ul>
      )}
      {member && bookmarks.length < BOOKMARKS_MAX && (
        <>
          <button
            type="button"
            onClick={() => {
              setAdding(true);
            }}
            className="flex shrink-0 items-center gap-1 rounded-pill px-2 py-1 text-label text-ink-muted transition-colors duration-hover ease-standard hover:bg-surface-200 hover:text-ink"
          >
            <Icon name="add" size="sm" />
            {t('bookmarks.add')}
          </button>
          <AddBookmarkDialog channel={channel} open={adding} onOpenChange={setAdding} onAdd={add} />
        </>
      )}
    </nav>
  );
};
