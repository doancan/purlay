/**
 * Step 8: finish (UX §11, D-179 §4.5). **Finish setup** is disabled until at least one way for other
 * people to sign in is connected and was tried; the administrator always has the password. The reasons
 * are the server's (`finishProblems`, every one that holds) and each is said; the server refuses the
 * finish too, so this screen explains a rule, it does not enforce one.
 */
import { FINISH_PROBLEMS, type FinishProblem } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import type { PlainKey } from '../../../i18n/types';
import { href } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, FailureNote, Note, StepHeader } from '../parts';
import type { StepProps } from './props';

const PROBLEMS: Record<FinishProblem, PlainKey> = {
  'out-of-order': 'setup.finish.problem.out-of-order',
  'no-workspace': 'setup.finish.problem.no-workspace',
  'no-channel': 'setup.finish.problem.no-channel',
};

const Row = ({
  ok,
  label,
  value,
}: {
  readonly ok: boolean;
  readonly label: string;
  readonly value?: string;
}): React.JSX.Element => (
  <li className="flex items-center gap-2 text-body">
    <span className={ok ? 'text-success-text' : 'text-ink-muted'}>
      <Icon name={ok ? 'confirm' : 'close'} size="md" />
    </span>
    <span className={cn(ok ? 'text-ink' : 'text-ink-muted')}>{label}</span>
    {value !== undefined && <span className="text-label text-ink-muted">· {value}</span>}
  </li>
);

export const FinishStep = ({ state, onBack, goTo }: StepProps): React.JSX.Element => {
  const { t } = useI18n();
  const { client, lose } = useSetup();
  const queries = useQueryClient();
  const { navigate } = useRoute();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const slug = state.workspace?.slug ?? null;

  const finish = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await client.finish();
      navigate(slug === null ? href('home') : href('workspace', { slug }), { replace: true });
      // After the move, so the screen being left does not ask again and the one arriving is not
      // emptied under its own first read: the setup's answers go, and whatever was read before there
      // was a person is read again.
      queries.removeQueries({ queryKey: ['setup'] });
      void queries.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'setup' });
    } catch (caught) {
      setFailure(caught);
      if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
      setBusy(false);
    }
  };

  const problems = FINISH_PROBLEMS.filter((one) => state.finishProblems.includes(one));
  const connect = (ok: boolean): string =>
    ok ? t('setup.finish.connected') : t('setup.finish.skipped');

  return (
    <div className="flex flex-col gap-6">
      <StepHeader title={t('setup.finish.title')} lede={t('setup.finish.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        <ul className="flex flex-col gap-2">
          <Row ok={state.admin !== null} label={t('setup.finish.admin')} />
          <Row ok={state.workspace !== null} label={t('setup.finish.workspace')} />
          <Row
            ok={state.channels.github || state.channels.email}
            label={t('setup.finish.channel')}
          />
          <li>
            <ul className="flex flex-col gap-1 pl-6">
              <Row
                ok={state.channels.github}
                label={t('setup.finish.github')}
                value={connect(state.channels.github)}
              />
              <Row
                ok={state.channels.email}
                label={t('setup.finish.email')}
                value={connect(state.channels.email)}
              />
            </ul>
          </li>
        </ul>
        {problems.map((one) => (
          <Note key={one} tone="warn">
            {t(PROBLEMS[one])}
          </Note>
        ))}
        {problems.includes('no-channel') && (
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                goTo('github');
              }}
            >
              {t('setup.finish.toGithub')}
            </Button>
            <Button
              onClick={() => {
                goTo('email');
              }}
            >
              {t('setup.finish.toEmail')}
            </Button>
          </div>
        )}
        {failure !== null && <FailureNote failure={failure} lead="setup.finish.failed" />}
      </div>
      <Actions
        start={
          onBack === null ? null : (
            <Button variant="ghost" onClick={onBack}>
              {t('setup.back')}
            </Button>
          )
        }
      >
        <Button
          variant="primary"
          busy={busy}
          disabled={!state.canFinish}
          onClick={() => {
            void finish();
          }}
        >
          {t('setup.finish.submit')}
        </Button>
      </Actions>
    </div>
  );
};
