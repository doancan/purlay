/**
 * Profile (#488, D-131, D-146): who you are to the people you work with. Your handle and avatar are
 * shown, not edited; your name is GitHub's where GitHub made the account, and yours to set otherwise
 * (D-235); your title, status line and time zone are yours.
 *
 * Only what you edit is sent; a field you have not touched shows what the server has, so a change made
 * in another tab appears here and is never sent back over it. A field emptied is cleared. The time
 * zone offers this device's in one press, and the zones this browser knows as you type. A refusal
 * says which field, in words, and keeps what you typed (`UX.md` §8).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import {
  PROFILE_STATUS_MAX,
  PROFILE_TITLE_MAX,
  type MeResponse,
  type Profile,
  type UpdateProfileRequest,
} from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { families, keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { useSession } from '../../session/session';
import { SaveOutcome, SettingsCard, SettingsPage, SettingsRow, SettingsTextRow } from '../page';
import { NameRow } from './name-row';

/** The zones this browser can format in, for the field's suggestions; none where it cannot say. */
const zonesHere = (): readonly string[] =>
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

/** This device's own zone. */
const deviceZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Field = 'title' | 'timeZone' | 'status';
const FIELDS: readonly Field[] = ['title', 'timeZone', 'status'];

export const ProfilePage = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const formId = useId();
  const zonesId = useId();
  const { user, profile, nameFromGitHub } = useSession();
  const [edited, setEdited] = useState<Partial<Record<Field, string>>>({});
  // Each field the server refused, with what to say; `form` for what names no field.
  const [problems, setProblems] = useState<Partial<Record<Field | 'form', string>>>({});
  const zones = useMemo(zonesHere, []);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');

  const shown = (field: Field): string => edited[field] ?? profile[field] ?? '';
  const asked = (field: Field): string | null | undefined => {
    const value = edited[field];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const wanted: UpdateProfileRequest = Object.fromEntries(
    FIELDS.map((field) => [field, asked(field)] as const).filter(
      ([field, value]) => value !== undefined && value !== profile[field],
    ),
  );
  const changed = Object.keys(wanted).length > 0;
  const busy = state === 'busy';

  const edit = (field: Field, value: string): void => {
    setEdited((now) => ({ ...now, [field]: value }));
    setState('idle');
  };

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setState('busy');
    setProblems({});
    let saved: Profile;
    try {
      saved = await api.updateProfile(wanted);
    } catch (failure) {
      setState('idle');
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        const refused = FIELDS.filter((field) => field in failure.fields);
        setProblems(
          refused.length === 0
            ? { form: `${t('profile.saveFailed')} ${describe(failure)}` }
            : Object.fromEntries(
                refused.map((field) => [
                  field,
                  t(field === 'timeZone' ? 'profile.zoneInvalid' : 'profile.wordsInvalid'),
                ]),
              ),
        );
      } else {
        setProblems({ form: `${t('profile.saveFailed')} ${describe(failure)}` });
      }
      return;
    }
    // The answer is the profile as it now is: drawn at once, not after `/api/me` is read again.
    client.setQueryData<MeResponse>(keys.me, (me) =>
      me === undefined ? me : { ...me, profile: saved },
    );
    setEdited({});
    setState('saved');
    // Wherever you are a member, your profile is read again — as the frame tells the others to.
    void client.invalidateQueries({ queryKey: families.members });
  };

  const errorOf = (field: Field): { error: string } | Record<string, never> => {
    const message = problems[field];
    return message === undefined ? {} : { error: message };
  };

  const outcome =
    problems.form !== undefined
      ? { ok: false, words: problems.form }
      : state === 'saved'
        ? { ok: true, words: t('profile.saved') }
        : null;

  return (
    <SettingsPage
      title={t('settings.profile.title')}
      description={t('settings.profile.description')}
    >
      <SettingsCard
        title={t('settings.profile.identity')}
        description={t(
          nameFromGitHub ? 'settings.profile.identityHint' : 'settings.profile.identityHintOwn',
        )}
      >
        <SettingsRow label={t('settings.profile.who')}>
          <div className="flex min-w-0 items-center gap-3">
            <Avatar size="lg" name={user.displayName} username={user.username} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-label text-ink">{user.displayName}</span>
              <span className="truncate font-mono text-caption text-ink-muted">
                @{user.username}
              </span>
            </span>
          </div>
        </SettingsRow>
        {!nameFromGitHub && <NameRow />}
      </SettingsCard>

      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <SettingsCard
          title={t('settings.profile.about')}
          description={t('settings.profile.aboutHint')}
          footer={
            <>
              <SaveOutcome outcome={outcome} />
              <Button type="submit" variant="primary" busy={busy} disabled={!changed}>
                {t('profile.save')}
              </Button>
            </>
          }
        >
          <SettingsTextRow
            readOnly={busy}
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
          <SettingsTextRow
            readOnly={busy}
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
          <SettingsTextRow
            readOnly={busy}
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
            after={
              <Button
                variant="ghost"
                className="-ml-3"
                onClick={() => {
                  edit('timeZone', deviceZone());
                }}
              >
                {t('profile.zoneHere')}
              </Button>
            }
          />
          <datalist id={zonesId}>
            {zones.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
        </SettingsCard>
      </form>
    </SettingsPage>
  );
};
