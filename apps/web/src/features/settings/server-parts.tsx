/**
 * What Administration → Server's cards share: the refresh after a change, a failure's sentence, the
 * form's reveal, and the dialog that asks before a way in is disconnected — and says outright, before
 * it is taken, when it is the last one.
 */
import type { ServerSettingsAnswer } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { isSetupFailure } from '../setup/client';
import { movementClass, useReducedMotion } from '../setup/motion';
import { FailureNote, Note } from '../setup/parts';
import { Dialog } from '../../ui/dialog';
import { SERVER_SETTINGS_KEY, useServerClient } from './server-context';

/** The page's query, read again after a change. */
export const useRefresh = (): (() => Promise<void>) => {
  const queries = useQueryClient();
  return async (): Promise<void> => {
    await queries.invalidateQueries({ queryKey: SERVER_SETTINGS_KEY });
  };
};

/** A form's reveal: a movement of the wizard's, and none under reduced motion. */
export const Reveal = ({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element => {
  const reduced = useReducedMotion();
  return <div className={cn(movementClass('step-in', reduced), className)}>{children}</div>;
};

/** A call that failed outright: the wizard's sentence, or the one for a setup still open. */
export const ChangeFailure = ({ failure }: { readonly failure: unknown }): React.JSX.Element => {
  const { t } = useI18n();
  if (isSetupFailure(failure) && failure.reason === 'setup-unfinished') {
    return <Note tone="warn">{t('settings.server.setupUnfinished')}</Note>;
  }
  return <FailureNote failure={failure} />;
};

/** The card's body, inset as a row is. */
export const Inset = ({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}): React.JSX.Element => (
  <div
    className={cn(
      'flex flex-col gap-4 not-first:border-t-hairline border-border-subtle px-6 py-5 max-narrow:px-4 max-narrow:py-4',
      className,
    )}
  >
    {children}
  </div>
);

/**
 * Disconnecting GitHub, single sign-on or the mail server, asked first. When the other way in is not there, the dialog
 * says before the button that this is the last one, and the button says it again; when the server
 * refuses for that reason although the page thought otherwise (somebody else changed it), the dialog
 * turns into that question and nothing has been taken.
 */
export const DisconnectDialog = ({
  channel,
  view,
  open,
  onOpenChange,
  title,
  body,
  done,
}: {
  readonly channel: 'github' | 'smtp' | 'oidc';
  readonly view: ServerSettingsAnswer;
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly title: string;
  readonly body: string;
  /** What to say once it is done: the card's outcome line. */
  readonly done: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [forced, setForced] = useState(false);
  // Another way in serves, or this is the last one: the page's own reading, which the server then confirms.
  const otherServes = (['github', 'email', 'oidc'] as const).some(
    (other) => other !== (channel === 'smtp' ? 'email' : channel) && view.channels[other],
  );
  const last = !otherServes || forced;

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await client.disconnect(channel, last);
      await refresh();
      onOpenChange(false);
      done();
    } catch (caught) {
      if (isSetupFailure(caught) && caught.reason === 'last-channel') setForced(true);
      else setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title={title}
      description={body}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              void disconnect();
            }}
          >
            {last ? t('settings.server.disconnectAnyway') : t('settings.server.disconnect')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {last && <Note tone="warn">{t('settings.server.lastWay')}</Note>}
        {failure !== null && <ChangeFailure failure={failure} />}
      </div>
    </Dialog>
  );
};
