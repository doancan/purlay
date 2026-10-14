/**
 * Your profile (#488, D-131): a title, the time zone your day is in, and a status line — from the
 * account menu. Your name and avatar are GitHub's, and stay so.
 *
 * Only what you edit is sent; a field you have not touched shows what the server has, so a change
 * made in another tab appears here and is never sent back over it. A field emptied is cleared. The
 * time zone offers this device's in one press, and the zones this browser knows as you type. A
 * refusal says which field, in words, and keeps what you typed (`UX.md` §8).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { PROFILE_STATUS_MAX, PROFILE_TITLE_MAX, type UpdateProfileRequest } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { families, keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';

/** The zones this browser can format in, for the field's suggestions; none where it cannot say. */
const zonesHere = (): readonly string[] =>
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/** This device's own zone. */
const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Field = 'title' | 'timeZone' | 'status';

export const ProfileDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const formId = useId();
  const zonesId = useId();
  const { profile } = useSession();
  const [edited, setEdited] = useState<Partial<Record<Field, string>>>({});
  const [problem, setProblem] = useState<{ field: Field | 'form'; message: string } | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');

  const shown = (field: Field): string => edited[field] ?? profile[field] ?? '';
  const asked = (field: Field): string | null | undefined => {
    const value = edited[field];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const wanted: UpdateProfileRequest = Object.fromEntries(
    (['title', 'timeZone', 'status'] as const)
      .map((field) => [field, asked(field)] as const)
      .filter(([field, value]) => value !== undefined && value !== profile[field]),
  );
  const changed = Object.keys(wanted).length > 0;

  const edit = (field: Field, value: string): void => {
    setEdited((now) => ({ ...now, [field]: value }));
    setState('idle');
  };

  const close = (next: boolean): void => {
    if (!next) {
      setEdited({});
      setProblem(null);
      setState('idle');
    }
    onOpenChange(next);
  };

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setState('busy');
    setProblem(null);
    try {
      await api.updateProfile(wanted);
      setEdited({});
      setState('saved');
      // Yours, and wherever you are a member: read again, as the frame tells the others to.
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.me }),
        client.invalidateQueries({ queryKey: families.members }),
      ]);
    } catch (failure) {
      setState('idle');
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        const field = (['timeZone', 'title', 'status'] as const).find((f) => f in failure.fields);
        setProblem({
          field: field ?? 'form',
          message: t(field === 'timeZone' ? 'profile.zoneInvalid' : 'profile.wordsInvalid'),
        });
      } else {
        setProblem({ field: 'form', message: `${t('profile.saveFailed')} ${describe(failure)}` });
      }
    }
  };

  const errorOf = (field: Field): { error: string } | Record<string, never> =>
    problem?.field === field ? { error: problem.message } : {};

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('profile.title')}
      description={t('profile.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <p role="status" className="text-label text-ink-muted">
            {state === 'saved' ? t('profile.saved') : ''}
          </p>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            busy={state === 'busy'}
            disabled={!changed}
          >
            {t('profile.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
        className="flex flex-col gap-3"
      >
        <TextField
          label={t('profile.titleLabel')}
          hint={t('profile.titleHint')}
          value={shown('title')}
          maxLength={PROFILE_TITLE_MAX}
          autoComplete="organization-title"
          {...errorOf('title')}
          onChange={(event) => {
            edit('title', event.target.value);
          }}
        />
        <TextField
          label={t('profile.statusLabel')}
          hint={t('profile.statusHint')}
          value={shown('status')}
          maxLength={PROFILE_STATUS_MAX}
          autoComplete="off"
          {...errorOf('status')}
          onChange={(event) => {
            edit('status', event.target.value);
          }}
        />
        <div className="flex flex-col gap-2">
          <TextField
            label={t('profile.zoneLabel')}
            hint={t('profile.zoneHint')}
            value={shown('timeZone')}
            list={zonesId}
            autoComplete="off"
            spellCheck={false}
            {...errorOf('timeZone')}
            onChange={(event) => {
              edit('timeZone', event.target.value);
            }}
          />
          <datalist id={zonesId}>
            {zonesHere().map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <div>
            <Button
              variant="ghost"
              onClick={() => {
                edit('timeZone', deviceZone());
              }}
            >
              {t('profile.zoneHere')}
            </Button>
          </div>
        </div>
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};
