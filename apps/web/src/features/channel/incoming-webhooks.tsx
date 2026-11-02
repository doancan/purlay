/**
 * A channel's incoming webhooks (D-245), in its details beside its repository feeds, for an owner or an
 * admin: which hooks post here, who made each and when it last posted; making one, and revoking one,
 * which asks first, in place, as disconnecting a feed does.
 *
 * Making one answers with its address, whose last part is the secret: it is shown here once — the
 * server keeps only a digest of it — so it is copied now or the hook is revoked and made again. It stays
 * on the screen until the person says Done.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Channel, CreatedIncomingWebhook, IncomingWebhook } from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { nameOf } from '../messages/author';

const sectionTitle = 'text-label font-semibold text-ink';

/** The address a tool posts to: this server's own origin and the path the hook was given. */
const addressOf = (created: CreatedIncomingWebhook): string =>
  `${window.location.origin}${created.path}`;

const Setup = ({
  created,
  onDone,
}: {
  readonly created: CreatedIncomingWebhook;
  readonly onDone: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { show } = useToast();
  const ports = useContentPorts();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The person's attention goes where the secret is, the one time it can be read.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const address = addressOf(created);
  const copy = (): void => {
    ports.copy(address).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3"
    >
      <h3 id={titleId} ref={heading} tabIndex={-1} className="text-label font-semibold text-ink">
        {t('hooks.setup.title', { name: created.webhook.name })}
      </h3>
      <p className="text-label text-ink-muted">
        {t('hooks.setup.steps', {
          example: JSON.stringify({ text: t('hooks.setup.example') }),
        })}
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <span
          data-hook-address=""
          className="min-w-0 flex-1 truncate font-mono text-label text-ink"
        >
          {address}
        </span>
        <Button variant="ghost" aria-label={t('hooks.setup.copy')} onClick={copy}>
          {t('common.copy')}
        </Button>
      </div>
      <p className="text-label text-warning-text">{t('hooks.setup.once')}</p>
      <div className="flex justify-end">
        <Button onClick={onDone}>{t('hooks.setup.done')}</Button>
      </div>
    </section>
  );
};

const Hook = ({
  hook,
  onRevoke,
}: {
  readonly hook: IncomingWebhook;
  readonly onRevoke: (hook: IncomingWebhook) => Promise<boolean>;
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
      box.current?.querySelector<HTMLElement>('[data-ask="revoke"]')?.focus();
      asked.current = false;
    }
  }, [asking]);
  const maker = hook.createdBy === null ? null : nameOf(hook.createdBy, t('user.erased'));
  const made = format.absolute(hook.createdAt);
  return (
    <li ref={box} className="flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-surface-200">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">{hook.name}</span>
        {!asking && (
          <Button
            variant="dangerQuiet"
            data-ask="revoke"
            aria-label={t('hooks.revokeOne', { name: hook.name })}
            onClick={() => {
              setAsking(true);
            }}
          >
            {t('hooks.revoke')}
          </Button>
        )}
      </div>
      <span className="text-caption text-ink-muted">
        {maker === null
          ? t('hooks.made', { when: made })
          : t('hooks.madeBy', { who: maker, when: made })}
        {' · '}
        {hook.lastUsedAt === null
          ? t('hooks.neverUsed')
          : t('hooks.lastUsed', { when: format.absolute(hook.lastUsedAt) })}
      </span>
      {asking && (
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
          <p id={questionId} className="text-label text-ink">
            {t('hooks.revokeAsk', { name: hook.name })}
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
                void onRevoke(hook).then((done) => {
                  setBusy(false);
                  if (!done) setAsking(false);
                });
              }}
            >
              {t('hooks.revoke')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
};

export const IncomingWebhooks = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const titleId = useId();
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<{ field: 'name' | 'form'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedIncomingWebhook | null>(null);

  const hooks = useQuery({
    queryKey: keys.incomingWebhooks(channel.id),
    queryFn: async ({ signal }) => await api.incomingWebhooks(channel.id, signal),
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.incomingWebhooks(channel.id) });
  };

  const make = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '') {
      setProblem({ field: 'name', message: t('hooks.nameRequired') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setCreated(await api.createIncomingWebhook(channel.id, { name: wanted }));
      setName('');
      await reread();
    } catch (failure) {
      // What the server refused about the name is said on the field (D-142).
      setProblem(
        isApiError(failure) && failure.code === 'VALIDATION_FAILED'
          ? { field: 'name', message: t('hooks.nameInvalid') }
          : { field: 'form', message: `${t('hooks.makeFailed')} ${describe(failure)}` },
      );
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (hook: IncomingWebhook): Promise<boolean> => {
    setProblem(null);
    try {
      await api.revokeIncomingWebhook(channel.id, hook.id);
      await reread();
      return true;
    } catch (failure) {
      setProblem({ field: 'form', message: `${t('hooks.revokeFailed')} ${describe(failure)}` });
      return false;
    }
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className={sectionTitle}>
        {t('hooks.title')}
      </h3>
      {hooks.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(hooks.error)}</p>
          <Button
            onClick={() => {
              void hooks.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : hooks.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
        </LoadingStatus>
      ) : hooks.data.length === 0 ? (
        <p className="text-body text-ink-muted">{t('hooks.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {hooks.data.map((hook) => (
            <Hook key={hook.id} hook={hook} onRevoke={revoke} />
          ))}
        </ul>
      )}
      {problem?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {problem.message}
        </p>
      )}
      {created === null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            void make(event);
          }}
        >
          <TextField
            label={t('hooks.name')}
            hint={t('hooks.nameHint')}
            value={name}
            autoComplete="off"
            {...(problem?.field === 'name' ? { error: problem.message } : {})}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={busy}>
              {t('hooks.make')}
            </Button>
          </div>
        </form>
      ) : (
        <Setup
          created={created}
          onDone={() => {
            setCreated(null);
          }}
        />
      )}
    </section>
  );
};
