/**
 * Administration → Modules (D-296, D-323): every module of the build, whether it is stopped for every workspace, and why; a stop
 * with the operator's reason and, where it takes the product down, a confirmation; a resume. What a stop takes with it is said
 * before it is asked, and what it took after. Its own chunk: an operator opens it a few times a year.
 */
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SUSPENSION_REASON_MAX,
  type ServerModuleStatus,
  type ServerModuleSuspensionResult,
} from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
import { Dialog } from '../../ui/dialog';
import { EmptyState } from '../../ui/states';
import { TextField } from '../../ui/text-field';
import { SettingsCard } from '../settings/page';
import { ChangeFailure } from '../settings/server-parts';
import { isSetupFailure } from '../setup/client';
import { Note } from '../setup/parts';
import { useAdministrationClient } from './context';
import { Facts, QueryState } from './parts';
import { keys } from '../../data/keys';

const MODULES_KEY = keys.serverModules;

/** A refusal the console words itself; anything else is said as every console card says it. */
const Refusal = ({
  failure,
  module,
}: {
  readonly failure: unknown;
  readonly module: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  if (isSetupFailure(failure) && failure.code === 'PEERS_BEHIND')
    return <Note tone="warn">{t('admin.modules.peersBehind', { module })}</Note>;
  return <ChangeFailure failure={failure} />;
};

/** The field a `VALIDATION_FAILED` named, when it is the one asked about. */
const refusedField = (failure: unknown, field: string): boolean =>
  isSetupFailure(failure) && failure.code === 'VALIDATION_FAILED' && field in failure.fields;

export const Modules = (): React.JSX.Element => {
  const client = useAdministrationClient();
  const { t } = useI18n();
  const query = useQuery({
    queryKey: MODULES_KEY,
    queryFn: async ({ signal }) => await client.modules(signal),
    retry: false,
  });
  const [stopping, setStopping] = useState<ServerModuleStatus | null>(null);
  const [outcome, setOutcome] = useState<ServerModuleSuspensionResult | null>(null);
  return (
    <>
      {outcome !== null && <Outcome result={outcome} />}
      <QueryState query={query}>
        {(data) =>
          data.data.length === 0 ? (
            <EmptyState title={t('admin.modules.empty')} body={t('admin.modules.empty.body')} />
          ) : (
            data.data.map((module) => (
              <ModuleCard
                key={module.module}
                module={module}
                onStop={() => {
                  setStopping(module);
                }}
                onDone={setOutcome}
              />
            ))
          )
        }
      </QueryState>
      {stopping !== null && (
        <StopDialog
          key={stopping.module}
          module={stopping}
          onClose={() => {
            setStopping(null);
          }}
          onDone={(result) => {
            setStopping(null);
            setOutcome(result);
          }}
        />
      )}
    </>
  );
};

/** What the last change came to, said once and announced. */
const Outcome = ({
  result,
}: {
  readonly result: ServerModuleSuspensionResult;
}): React.JSX.Element => {
  const { t } = useI18n();
  const stopped = result.state === 'suspended';
  return (
    <Note tone="good">
      {!result.changed
        ? t(stopped ? 'admin.modules.alreadyStopped' : 'admin.modules.alreadyRunning', {
            module: result.module,
          })
        : t(stopped ? 'admin.modules.stopped' : 'admin.modules.resumed', {
            module: result.module,
          })}
      {result.changed && result.alsoAffected.length > 0
        ? ` ${t(stopped ? 'admin.modules.stoppedWith' : 'admin.modules.resumedWith', {
            modules: result.alsoAffected.join(', '),
          })}`
        : ''}
    </Note>
  );
};

const ModuleCard = ({
  module,
  onStop,
  onDone,
}: {
  readonly module: ServerModuleStatus;
  readonly onStop: () => void;
  readonly onDone: (result: ServerModuleSuspensionResult) => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const queries = useQueryClient();
  const { t, format } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const resume = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      onDone(await client.moduleSuspension(module.module, { state: 'running' }));
    } catch (error) {
      setFailure(error);
    } finally {
      await queries.invalidateQueries({ queryKey: keys.server });
      setBusy(false);
    }
  };
  return (
    <SettingsCard
      title={module.module}
      description={t(`admin.modules.state.${module.state}`)}
      actions={
        module.state === 'active' ? (
          <Button variant="dangerQuiet" onClick={onStop}>
            {t('admin.modules.stop')}
          </Button>
        ) : module.state === 'suspended' ? (
          <Button
            busy={busy}
            onClick={() => {
              void resume();
            }}
          >
            {t('admin.modules.resume')}
          </Button>
        ) : undefined
      }
    >
      <Facts
        items={[
          [
            t('admin.modules.served'),
            t(module.running ? 'admin.modules.served.yes' : 'admin.modules.served.no'),
          ],
          ...(module.state === 'suspended'
            ? ([
                [t('admin.modules.reason'), module.reason ?? t('admin.none')],
                [
                  t('admin.modules.since'),
                  module.suspendedAt === null
                    ? t('admin.none')
                    : format.absolute(module.suspendedAt),
                ],
              ] as const)
            : []),
          ...(module.state === 'active'
            ? ([
                [
                  t('admin.modules.stopsWith'),
                  module.stopsWith.length === 0
                    ? t('admin.modules.stopsWith.none')
                    : module.stopsWith.join(', '),
                ],
              ] as const)
            : []),
        ]}
      />
      {failure !== null && (
        <div className="px-6 pb-4 max-narrow:px-4">
          <Refusal failure={failure} module={module.module} />
        </div>
      )}
    </SettingsCard>
  );
};

/** The stop: the reason the trail keeps, what goes with it, and the confirmation a stop of the product needs (`force`). */
const StopDialog = ({
  module,
  onClose,
  onDone,
}: {
  readonly module: ServerModuleStatus;
  readonly onClose: () => void;
  readonly onDone: (result: ServerModuleSuspensionResult) => void;
}): React.JSX.Element => {
  const client = useAdministrationClient();
  const queries = useQueryClient();
  const { t } = useI18n();
  const confirmId = useId();
  const [reason, setReason] = useState('');
  const [meant, setMeant] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  // The list may be older than the server: a refusal that asks for the confirmation asks for it here too.
  const needsForce = module.stopNeedsForce || refusedField(failure, 'force');
  const stop = async (): Promise<void> => {
    if (busy || (needsForce && !meant)) return;
    setBusy(true);
    setFailure(null);
    try {
      onDone(
        await client.moduleSuspension(module.module, {
          state: 'suspended',
          reason,
          ...(needsForce ? { force: true } : {}),
        }),
      );
    } catch (error) {
      setFailure(error);
    } finally {
      await queries.invalidateQueries({ queryKey: keys.server });
      setBusy(false);
    }
  };
  const reasonRefused = refusedField(failure, 'reason');
  const otherFailure =
    failure !== null && !reasonRefused && !refusedField(failure, 'force') ? failure : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={t('admin.modules.stopTitle', { module: module.module })}
      description={t('admin.modules.stopBody')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={needsForce && !meant}
            onClick={() => {
              void stop();
            }}
          >
            {t('admin.modules.stopConfirm')}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void stop();
        }}
      >
        <TextField
          label={t('admin.modules.reason')}
          hint={t('admin.modules.reasonHint', { max: SUSPENSION_REASON_MAX })}
          value={reason}
          maxLength={SUSPENSION_REASON_MAX}
          readOnly={busy}
          required
          onChange={(event) => {
            setReason(event.target.value);
          }}
          {...(reasonRefused ? { error: t('admin.modules.reasonNeeded') } : {})}
        />
        {module.stopsWith.length > 0 && (
          <Note tone="warn">
            {t('admin.modules.alsoStops', { modules: module.stopsWith.join(', ') })}
          </Note>
        )}
        {needsForce && (
          <label htmlFor={confirmId} className="flex items-start gap-2 text-body text-ink">
            <Checkbox
              id={confirmId}
              checked={meant}
              disabled={busy}
              onChange={(event) => {
                setMeant(event.target.checked);
              }}
            />
            <span>{t('admin.modules.force', { module: module.module })}</span>
          </label>
        )}
        {otherFailure !== null && <Refusal failure={otherFailure} module={module.module} />}
      </form>
    </Dialog>
  );
};
