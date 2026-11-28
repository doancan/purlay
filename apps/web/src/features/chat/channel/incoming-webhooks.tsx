/**
 * A channel's incoming webhooks (D-245), in its details beside its repository feeds, for an owner or an
 * admin: which hooks post here, who made each and when it last posted; making one, and revoking one,
 * which asks first, in place, as disconnecting a feed does.
 *
 * Making one answers with its address, whose last part is the secret: it is shown here once — the
 * server keeps only a digest of it — so it is copied now or the hook is revoked and made again. It stays
 * on the screen until the person says Done.
 */
import { acceptWebhook } from './webhook-cache';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Channel, CreatedIncomingWebhook, IncomingWebhook } from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError, isUnconfirmedMutation } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Icon } from '../../../components/icon';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { TextField } from '../../../ui/text-field';
import { useCopier } from '../../content/content-ports';
import { nameOf } from '../../../lib/author';

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
  const copyText = useCopier();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const [sending, setSending] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; words: string } | null>(null);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The person's attention goes where the secret is, the one time it can be read.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const address = addressOf(created);
  const copy = (text: string): void => {
    copyText(text);
  };
  const test = async (): Promise<void> => {
    setSending(true);
    setTestResult(null);
    try {
      await api.postIncomingWebhook(created.path, t('hooks.setup.testText'));
      setTestResult({ ok: true, words: t('hooks.setup.testAccepted') });
      // The receipt is authoritative even if this status refresh fails; the query owns that error.
      void client.invalidateQueries({ queryKey: keys.incomingWebhooks(created.webhook.channelId) });
    } catch (failure) {
      setTestResult({
        ok: false,
        words: isUnconfirmedMutation(failure)
          ? t('hooks.setup.testUnconfirmed')
          : describe(failure),
      });
    } finally {
      setSending(false);
    }
  };
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 rounded-md border-hairline border-border-subtle bg-surface-050 p-4"
    >
      <h3 id={titleId} ref={heading} tabIndex={-1} className="text-label font-semibold text-ink">
        {t('hooks.setup.title', { name: created.webhook.name })}
      </h3>
      <p className="text-label text-ink-muted">
        {t('hooks.setup.steps', {
          example: JSON.stringify({ text: t('hooks.setup.example') }),
        })}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border-hairline border-border-subtle bg-surface-100 p-2">
        <span
          data-hook-address=""
          className="min-w-0 flex-1 select-all break-all font-mono text-label text-ink"
        >
          {address}
        </span>
        <Button
          variant="ghost"
          glyph="copy"
          aria-label={t('hooks.setup.copy')}
          onClick={() => {
            copy(address);
          }}
        >
          {t('common.copy')}
        </Button>
      </div>
      <p className="text-label text-warning-text">{t('hooks.setup.once')}</p>
      {testResult !== null && (
        <p
          role={testResult.ok ? 'status' : 'alert'}
          className={testResult.ok ? 'text-label text-success-text' : 'text-label text-danger-text'}
        >
          {testResult.words}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            copy(JSON.stringify({ text: t('hooks.setup.example') }));
          }}
        >
          {t('hooks.setup.copyExample')}
        </Button>
        <Button
          busy={sending}
          onClick={() => {
            void test();
          }}
        >
          {t('hooks.setup.test')}
        </Button>
        <Button onClick={onDone}>{t('hooks.setup.done')}</Button>
      </div>
    </section>
  );
};

const Hook = ({
  hook,
  onRevoke,
  onRotate,
}: {
  readonly hook: IncomingWebhook;
  readonly onRevoke: (hook: IncomingWebhook) => Promise<boolean>;
  readonly onRotate: (hook: IncomingWebhook) => Promise<void>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const [asking, setAsking] = useState(false);
  const [rotating, setRotating] = useState(false);
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
    <li
      ref={box}
      className="flex min-w-0 flex-col gap-2 border-border-subtle py-4 first:pt-0 not-last:border-b-hairline last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 wrap-anywhere text-body font-semibold text-ink">
          {hook.name}
        </span>
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
      {hook.lastRequestAt !== undefined && (
        <p className="text-caption text-ink-muted">
          {t('outHooks.lastRequest', {
            when: format.absolute(hook.lastRequestAt),
            status: hook.lastStatus ?? 0,
          })}
          {hook.lastError === null || hook.lastError === undefined ? '' : ` · ${hook.lastError}`}
        </p>
      )}
      <Button
        variant="ghost"
        className="self-start"
        disabled={busy}
        onClick={() => {
          setRotating(true);
        }}
      >
        {t('outHooks.rotate')}
      </Button>
      {rotating && (
        <div className="flex flex-col gap-2">
          <p className="text-body">{t('outHooks.incomingRotate')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                setRotating(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              busy={busy}
              onClick={() => {
                setBusy(true);
                void onRotate(hook).finally(() => {
                  setBusy(false);
                  setRotating(false);
                });
              }}
            >
              {t('outHooks.rotate')}
            </Button>
          </div>
        </div>
      )}
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

const ChannelWebhooks = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const titleId = useId();
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  const [problem, setProblem] = useState<{ field: 'name' | 'form'; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedIncomingWebhook | null>(null);
  useEffect(() => {
    if (adding) nameInput.current?.focus();
    else if (created === null && wasEditing.current) addButton.current?.focus();
    wasEditing.current = adding || created !== null;
  }, [adding, created]);

  const hooks = useQuery({
    refetchInterval: 5000,
    queryKey: keys.incomingWebhooks(channel.id),
    queryFn: async ({ signal }) => await api.incomingWebhooks(channel.id, signal),
  });
  const accepted = async (id: string, hook: IncomingWebhook | null): Promise<void> => {
    await acceptWebhook(client, keys.incomingWebhooks(channel.id), id, hook);
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
      const result = await api.createIncomingWebhook(channel.id, { name: wanted });
      setCreated(result);
      setAdding(false);
      setName('');
      await accepted(result.webhook.id, result.webhook);
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
      await accepted(hook.id, null);
      return true;
    } catch (failure) {
      setProblem({ field: 'form', message: `${t('hooks.revokeFailed')} ${describe(failure)}` });
      return false;
    }
  };

  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-4 rounded-lg border-hairline border-border-subtle bg-surface-100 p-4 max-narrow:p-3"
    >
      <header className="flex items-start gap-3">
        <span className="flex size-control shrink-0 items-center justify-center rounded-md bg-surface-200 text-ink-muted">
          <Icon name="download" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="text-body font-semibold text-ink">
            {t('hooks.title')}
          </h3>
          <p className="text-label text-ink-muted">{t('hooks.body')}</p>
        </div>
      </header>
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
      ) : null}
      {hooks.data === undefined ? (
        hooks.isError ? null : (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
            <Skeleton />
          </LoadingStatus>
        )
      ) : hooks.data.length === 0 ? (
        <p className="border-t-hairline border-border-subtle pt-3 text-label text-ink-muted">
          {t('hooks.empty')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {hooks.data.map((hook) => (
            <Hook
              key={hook.id}
              hook={hook}
              onRevoke={revoke}
              onRotate={async (chosen) => {
                setProblem(null);
                try {
                  const result = await api.rotateIncomingWebhook(channel.id, chosen.id);
                  setCreated(result);
                  await accepted(result.webhook.id, result.webhook);
                } catch (error) {
                  setProblem({ field: 'form', message: describe(error) });
                }
              }}
            />
          ))}
        </ul>
      )}
      {problem?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {problem.message}
        </p>
      )}
      {created === null && (hooks.data?.length ?? 0) > 0 && !adding ? (
        <div className="flex justify-end border-t-hairline border-border-subtle pt-3">
          <Button
            ref={addButton}
            glyph="add"
            onClick={() => {
              setAdding(true);
            }}
          >
            {t('hooks.make')}
          </Button>
        </div>
      ) : created === null ? (
        <form
          className="flex flex-col gap-4 border-t-hairline border-border-subtle pt-4"
          onSubmit={(event) => {
            void make(event);
          }}
        >
          <TextField
            ref={nameInput}
            label={t('hooks.name')}
            placeholder={t('hooks.namePlaceholder')}
            hint={t('hooks.nameHint')}
            value={name}
            autoComplete="off"
            {...(problem?.field === 'name' ? { error: problem.message } : {})}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <div className="flex flex-wrap justify-end gap-2">
            {adding && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                }}
              >
                {t('common.cancel')}
              </Button>
            )}
            <Button type="submit" variant="primary" glyph="add" busy={busy}>
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
/** A new target must never inherit a previous channel's one-time credential or pending result. */
export const IncomingWebhooks = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <ChannelWebhooks key={channel.id} channel={channel} />
);
