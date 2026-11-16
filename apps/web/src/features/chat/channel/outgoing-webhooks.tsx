/** Outgoing hooks: explicit content sharing, one-time secrets and delivery evidence (D-312). */
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import type { CreatedOutgoingWebhook, OutgoingWebhook, WebhookEventType } from '@purlay/types';
import { acceptWebhook } from './webhook-cache';
import { isApiError } from '../../../data/errors';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { Checkbox } from '../../../ui/checkbox';
import { useContentPorts } from '../../content/content-ports';

const events: readonly WebhookEventType[] = [
  'message.created',
  'thread.resolved',
  'thread.reopened',
];

const Attempts = ({
  channelId,
  hookId,
  deliveryId,
}: {
  readonly channelId: string;
  readonly hookId: string;
  readonly deliveryId: string;
}): React.JSX.Element => {
  const api = useApi();
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const query = useQuery({
    queryKey: ['webhook-attempts', deliveryId],
    queryFn: async ({ signal }) => await api.webhookAttempts(channelId, hookId, deliveryId, signal),
  });
  if (query.isPending) return <p role="status">{t('common.loading')}</p>;
  if (query.isError)
    return (
      <div>
        <p role="alert">{describe(query.error)}</p>
        <Button
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('common.retry')}
        </Button>
      </div>
    );
  return (
    <ul className="flex flex-col gap-1 text-caption text-ink-muted">
      {query.data.length === 0 ? (
        <li>{t('outHooks.noAttempts')}</li>
      ) : (
        query.data.map((attempt) => (
          <li key={attempt.id}>
            {format.absolute(attempt.attemptedAt)} · {attempt.status ?? attempt.error} ·{' '}
            {format.number(attempt.durationMs)} ms
          </li>
        ))
      )}
    </ul>
  );
};

const Deliveries = ({
  channelId,
  hook,
}: {
  readonly channelId: string;
  readonly hook: OutgoingWebhook;
}): React.JSX.Element => {
  const api = useApi();
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const [attempts, setAttempts] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['webhook-deliveries', hook.id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      await api.webhookDeliveries(channelId, hook.id, pageParam, signal),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
  });
  const retry = async (id: string): Promise<void> => {
    setBusy(id);
    setFailure(null);
    try {
      await api.retryWebhookDelivery(channelId, hook.id, id);
      await query.refetch();
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className="text-label font-semibold">{t('outHooks.deliveries')}</h4>
      {query.isPending ? (
        <p role="status">{t('common.loading')}</p>
      ) : query.isError ? (
        <div>
          <p role="alert">{describe(query.error)}</p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : query.data.pages.every((page) => page.data.length === 0) ? (
        <p className="text-body text-ink-muted">{t('outHooks.emptyDeliveries')}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {query.data.pages
            .flatMap((page) => page.data)
            .map((delivery) => (
              <li
                key={delivery.id}
                className="flex min-w-0 flex-col gap-1 border-b-hairline border-border-subtle pb-2"
              >
                <span className="break-words text-label">
                  {delivery.eventType} · {t(`outHooks.state.${delivery.state}`)}
                </span>
                <span className="text-caption text-ink-muted">
                  {format.absolute(delivery.createdAt)} ·{' '}
                  {t('outHooks.attemptCount', { count: delivery.attemptCount })} ·{' '}
                  {delivery.lastStatus ?? delivery.lastError ?? '—'}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => {
                      setAttempts(attempts === delivery.id ? null : delivery.id);
                    }}
                  >
                    {t('outHooks.attempts')}
                  </Button>
                  {delivery.state === 'failed' && !hook.paused && (
                    <Button
                      busy={busy === delivery.id}
                      onClick={() => {
                        void retry(delivery.id);
                      }}
                    >
                      {t('common.retry')}
                    </Button>
                  )}
                </div>
                {attempts === delivery.id && (
                  <Attempts channelId={channelId} hookId={hook.id} deliveryId={delivery.id} />
                )}
              </li>
            ))}
        </ul>
      )}
      {query.hasNextPage && (
        <Button
          busy={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {t('outHooks.more')}
        </Button>
      )}
      {failure !== null && (
        <p role="alert" className="text-body text-danger-text">
          {failure}
        </p>
      )}
    </div>
  );
};

const Hook = ({
  channelId,
  hook,
  onSecret,
  onChanged,
}: {
  readonly channelId: string;
  readonly hook: OutgoingWebhook;
  readonly onSecret: (created: CreatedOutgoingWebhook) => void;
  readonly onChanged: (id: string, row: OutgoingWebhook | 'revoke' | undefined) => Promise<void>;
}): React.JSX.Element => {
  const api = useApi();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'revoke' | null>(null);
  const run = async (
    action: () => Promise<OutgoingWebhook | 'revoke' | undefined>,
  ): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const row = await action();
      setConfirm(null);
      await onChanged(hook.id, row);
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-w-0 flex-col gap-2 border-b-hairline border-border-subtle py-3">
      <h4 className="break-words text-body font-semibold">
        {hook.name} · {hook.paused ? t('outHooks.paused') : t('outHooks.active')}
      </h4>
      <p className="break-all font-mono text-caption text-ink-muted">{hook.url}</p>
      <p className="text-caption text-ink-muted">
        {hook.events.map((event) => t(`outHooks.event.${event}`)).join(' · ')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          busy={busy}
          onClick={() => {
            void run(async () => {
              await api.changeOutgoingWebhook(channelId, hook.id, !hook.paused);
              return { ...hook, paused: !hook.paused };
            });
          }}
        >
          {hook.paused ? t('outHooks.resume') : t('outHooks.pause')}
        </Button>
        <Button
          busy={busy}
          disabled={hook.paused}
          onClick={() => {
            void run(async () => {
              await api.testOutgoingWebhook(channelId, hook.id);
              setHistory(true);
              return undefined;
            });
          }}
        >
          {t('outHooks.test')}
        </Button>
        <Button
          onClick={() => {
            setHistory(!history);
          }}
        >
          {t('outHooks.deliveries')}
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setConfirm('rotate');
          }}
        >
          {t('outHooks.rotate')}
        </Button>
        <Button
          variant="dangerQuiet"
          disabled={busy}
          onClick={() => {
            setConfirm('revoke');
          }}
        >
          {t('hooks.revoke')}
        </Button>
      </div>
      {confirm !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-body">
            {confirm === 'rotate' ? t('outHooks.rotateConfirm') : t('outHooks.revokeConfirm')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy}
              onClick={() => {
                setConfirm(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              busy={busy}
              variant="dangerQuiet"
              onClick={() => {
                void run(async () => {
                  if (confirm === 'rotate') {
                    const rotated = await api.rotateOutgoingWebhook(channelId, hook.id);
                    onSecret(rotated);
                    return rotated.webhook;
                  }
                  await api.changeOutgoingWebhook(channelId, hook.id, 'revoke');
                  return 'revoke';
                });
              }}
            >
              {confirm === 'rotate' ? t('outHooks.rotate') : t('hooks.revoke')}
            </Button>
          </div>
        </div>
      )}
      {failure !== null && (
        <p role="alert" className="text-body text-danger-text">
          {failure}
        </p>
      )}
      {history && <Deliveries channelId={channelId} hook={hook} />}
    </li>
  );
};

const ChannelOutgoingWebhooks = ({
  channelId,
}: {
  readonly channelId: string;
}): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const ports = useContentPorts();
  const title = useId();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [selected, setSelected] = useState<readonly WebhookEventType[]>(['message.created']);
  const [created, setCreated] = useState<CreatedOutgoingWebhook | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fields, setFields] = useState<Readonly<Record<string, string>>>({});
  const secretHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (created !== null) secretHeading.current?.focus();
  }, [created]);
  const query = useQuery({
    queryKey: ['outgoing-webhooks', channelId],
    queryFn: async ({ signal }) => await api.outgoingWebhooks(channelId, signal),
  });
  const reread = async (id: string, row: OutgoingWebhook | 'revoke' | undefined): Promise<void> => {
    if (row === undefined)
      await client.invalidateQueries({ queryKey: ['outgoing-webhooks', channelId] });
    else
      await acceptWebhook(
        client,
        ['outgoing-webhooks', channelId],
        id,
        row === 'revoke' ? null : row,
      );
  };
  const make = async (event: React.SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setFields({});
    try {
      const result = await api.createOutgoingWebhook(channelId, {
        name: name.trim(),
        url: url.trim(),
        events: [...selected],
      });
      setCreated(result);
      setName('');
      setUrl('');
      await reread(result.webhook.id, result.webhook);
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_FAILED') setFields(error.fields);
      setFailure(describe(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby={title} className="flex min-w-0 flex-col gap-3">
      <h3 id={title} className="text-label font-semibold text-ink">
        {t('outHooks.title')}
      </h3>
      <p className="text-body text-ink-muted">{t('outHooks.body')}</p>
      {query.isPending ? (
        <p role="status">{t('common.loading')}</p>
      ) : query.data === undefined ? (
        <div>
          <p role="alert">{describe(query.error)}</p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : query.data.length === 0 ? (
        <p className="text-body text-ink-muted">{t('outHooks.empty')}</p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {query.data.map((hook) => (
            <Hook
              key={hook.id}
              channelId={channelId}
              hook={hook}
              onSecret={setCreated}
              onChanged={reread}
            />
          ))}
        </ul>
      )}
      {query.isError && query.data !== undefined && (
        <div>
          <p role="alert">
            {t('outHooks.refreshFailed')} {describe(query.error)}
          </p>
          <Button
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      )}
      {created !== null ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3">
          <h4 ref={secretHeading} tabIndex={-1} className="text-label font-semibold">
            {t('outHooks.secret')}
          </h4>
          <p className="text-body text-ink-muted">{t('outHooks.secretOnce')}</p>
          <code className="break-all text-caption">{created.secret}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void ports.copy(created.secret).then(
                  () => {
                    setCopied(true);
                  },
                  () => {
                    setFailure(t('failure.copy'));
                  },
                );
              }}
            >
              {t('common.copy')}
            </Button>
            <Button
              onClick={() => {
                setCreated(null);
                setCopied(false);
              }}
            >
              {t('hooks.setup.done')}
            </Button>
          </div>
          {copied && <p role="status">{t('common.copied')}</p>}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            void make(event);
          }}
          className="flex flex-col gap-2"
        >
          <TextField
            label={t('outHooks.name')}
            {...(fields['name'] === undefined ? {} : { error: t('hooks.nameInvalid') })}
            value={name}
            required
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <TextField
            label={t('outHooks.url')}
            {...(fields['url'] === undefined ? {} : { error: t('outHooks.urlInvalid') })}
            type="url"
            value={url}
            required
            autoComplete="off"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
          />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-label">{t('outHooks.events')}</legend>
            {events.map((event) => (
              <label key={event} className="flex items-start gap-2 text-body">
                <Checkbox
                  checked={selected.includes(event)}
                  onChange={(change) => {
                    setSelected(
                      change.target.checked
                        ? [...selected, event]
                        : selected.filter((value) => value !== event),
                    );
                  }}
                />
                {t(`outHooks.event.${event}`)}
              </label>
            ))}
          </fieldset>
          {fields['events'] !== undefined && (
            <p role="alert" className="text-body text-danger-text">
              {t('outHooks.eventsInvalid')}
            </p>
          )}
          <p className="text-body text-warning-text">{t('outHooks.disclosure')}</p>
          <Button type="submit" variant="primary" busy={busy}>
            {t('outHooks.make')}
          </Button>
        </form>
      )}
      {failure !== null && (
        <p role="alert" className="text-body text-danger-text">
          {failure}
        </p>
      )}
    </section>
  );
};

/** A changed channel gets fresh form and one-time credential state, including late responses. */
export const OutgoingWebhooks = ({
  channelId,
}: {
  readonly channelId: string;
}): React.JSX.Element => <ChannelOutgoingWebhooks key={channelId} channelId={channelId} />;
