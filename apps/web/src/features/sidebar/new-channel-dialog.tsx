/**
 * Make a channel: a name, an optional topic, and nothing else (`API.md` §4).
 *
 * The name is put into the form the contract states as it is typed — "Genel Sohbet" becomes
 * `genel-sohbet` (`channel-name.ts`, D-123) — and checked against it before a round trip; the server stays the authority, and what it
 * refuses comes back into the same field: a taken name as "taken", a field it names as
 * "invalid", anything else as one line under the form. The form is left as it was on a
 * failure, so nothing typed is lost to a retry.
 */
import { useDescribeFailure } from '../../data/failure';
import { useId, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Icon } from '../../components/icon';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useWorkspace } from '../shell/workspace';
import { CHANNEL_NAME, CHANNEL_NAME_MAX, finishedChannelName } from '../channel/channel-name';
import { typeChannelName } from '../channel/name-field';
import { Checkbox } from '../../ui/checkbox';

interface Problem {
  readonly field: 'name' | 'form';
  readonly message: string;
}

export const NewChannelDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { createChannel } = useActions();
  const { navigate } = useRoute();
  const formId = useId();
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [secret, setSecret] = useState(false);
  const privateHint = useId();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  const change = (next: boolean): void => {
    if (!next) {
      setName('');
      setTopic('');
      setSecret(false);
      setProblem(null);
      setBusy(false);
    }
    onOpenChange(next);
  };

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = finishedChannelName(name);
    if (!CHANNEL_NAME.test(wanted)) {
      setProblem({ field: 'name', message: t('newChannel.invalid') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const channel = await createChannel(workspace.id, {
        name: wanted,
        ...(topic.trim() === '' ? {} : { topic: topic.trim() }),
        ...(secret ? { type: 'private' as const } : {}),
      });
      change(false);
      navigate(href('channel', { slug: workspace.slug, channelId: channel.id }));
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'CHANNEL_NAME_TAKEN') {
        setProblem({ field: 'name', message: t('newChannel.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem({ field: 'name', message: t('newChannel.invalid') });
      } else {
        setProblem({ field: 'form', message: `${t('newChannel.failed')} ${describe(failure)}` });
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('newChannel.title')}
      description={t('newChannel.description')}
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
            {t('newChannel.create')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-4"
      >
        <TextField
          label={t('newChannel.name')}
          hint={t('newChannel.nameHint')}
          value={name}
          maxLength={CHANNEL_NAME_MAX}
          required
          autoComplete="off"
          spellCheck={false}
          {...(problem?.field === 'name' ? { error: problem.message } : {})}
          onChange={(event) => {
            typeChannelName(event.target, setName);
          }}
        />
        <TextField
          label={t('newChannel.topic')}
          hint={t('newChannel.topicHint')}
          value={topic}
          autoComplete="off"
          onChange={(event) => {
            setTopic(event.target.value);
          }}
        />
        <label className="flex items-start gap-2 text-body text-ink">
          <Checkbox
            checked={secret}
            aria-describedby={privateHint}
            onChange={(event) => {
              setSecret(event.target.checked);
            }}
          />
          <span className="flex flex-col">
            <span className="flex items-center gap-1">
              <Icon name="private-channel" size="sm" />
              {t('newChannel.private')}
            </span>
            <span id={privateHint} className="text-caption text-ink-muted">
              {t('newChannel.privateHint')}
            </span>
          </span>
        </label>
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};
