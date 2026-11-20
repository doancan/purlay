/**
 * Profile (#488, D-131, D-146): who you are to the people you work with. Your handle and avatar are
 * shown, not edited; your name is GitHub's where GitHub made the account, and yours to set otherwise
 * (D-235); your title, status line and time zone are yours.
 *
 * Only what you edit is sent; a field you have not touched shows what the server has, so a change made
 * in another tab appears here and is never sent back over it. A field emptied is cleared. The time
 * zone offers this device's in one press, and the zones this browser knows as you type. A refusal
 * says which field, in words, and keeps what you typed (`UX.md` §8).
 *
 * The status line is its words, an emoji and when it clears itself (D-330), sent together whenever one of them
 * is changed: 30 minutes, an hour, four hours, the end of today or of this week on this device's clock, or never.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useContext, useId, useMemo, useState } from 'react';
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
import { profileTimeZoneChanged } from '../../../data/cache';
import { useI18n } from '../../../i18n/i18n-provider';
import { statusLineAt, untilText } from '../../../lib/status-line';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { Select } from '../../../ui/select';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { systemClock } from '../../../system-clock';
import { STATUS_CLEARS, statusEnd, type StatusClear } from './status-clears';
import { useSession } from '../../session/session';
import { SaveOutcome, SettingsCard, SettingsPage, SettingsRow, SettingsTextRow } from '../page';
import { NameRow } from './name-row';
import { CompanySessionNotice } from './company-parts';

/** The zones this browser can format in, for the field's suggestions; none where it cannot say. */
const zonesHere = (): readonly string[] =>
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

type Field = 'title' | 'timeZone' | 'status' | 'statusEmoji';
const FIELDS: readonly Field[] = ['title', 'timeZone'];
/** The status line's own: written together, as the server takes it (D-330). */
const LINE: readonly Field[] = ['status', 'statusEmoji'];
/** What a refusal of each field is said as. */
const REFUSED = {
  title: 'profile.wordsInvalid',
  status: 'profile.wordsInvalid',
  timeZone: 'profile.zoneInvalid',
  statusEmoji: 'profile.emojiInvalid',
  statusUntil: 'profile.clearInvalid',
} as const satisfies Readonly<Record<Field | 'statusUntil', string>>;

export const ProfilePage = (): React.JSX.Element => {
  const { companyWorkspaceId } = useSession();
  return companyWorkspaceId === undefined ? <IndependentProfilePage /> : <CompanyProfilePage />;
};

const CompanyProfilePage = (): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  return (
    <SettingsPage
      title={t('settings.profile.title')}
      description={t('settings.profile.description')}
    >
      <CompanySessionNotice />
      <SettingsCard>
        <SettingsRow label={t('profile.nameLabel')}>
          <span className="text-body text-ink">{user.displayName}</span>
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
};

const IndependentProfilePage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const formId = useId();
  const zonesId = useId();
  // What this device would fill in: shown as the empty field's placeholder, and what the button writes.
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { user, profile, nameFromGitHub } = useSession();
  const [edited, setEdited] = useState<Partial<Record<Field, string>>>({});
  // When the status line clears itself, as chosen here; `keep` is the end it already has.
  const [clear, setClear] = useState<StatusClear | 'keep' | undefined>(undefined);
  // Each field the server refused, with what to say; `form` for what names no field.
  const [problems, setProblems] = useState<Partial<Record<Field | 'statusUntil' | 'form', string>>>(
    {},
  );
  const zones = useMemo(zonesHere, []);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  // This render's instant, on the page's clock: what "today" and a past end are judged by.
  const minute = (useContext(RealtimePortsContext).clock ?? systemClock).now().getTime();
  // The line as it reads now: one past its end is no line, whatever was read before (D-330).
  const line = statusLineAt(profile, minute);
  const stored: Readonly<Record<Field, string | null>> = {
    title: profile.title,
    timeZone: profile.timeZone,
    status: line?.words ?? null,
    statusEmoji: line?.emoji ?? null,
  };
  const keptUntil = line?.until ?? null;
  const clearShown = clear ?? (keptUntil === null ? 'never' : 'keep');

  const shown = (field: Field): string => edited[field] ?? stored[field] ?? '';
  const asked = (field: Field): string | null | undefined => {
    const value = edited[field];
    if (value === undefined) return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  };
  const lineChanged =
    clear !== undefined ||
    LINE.some((field) => asked(field) !== undefined && asked(field) !== stored[field]);
  const wantedLine = (): UpdateProfileRequest => {
    if (!lineChanged) return {};
    const words = asked('status');
    const emoji = asked('statusEmoji');
    return {
      status: words === undefined ? stored.status : words,
      statusEmoji: emoji === undefined ? stored.statusEmoji : emoji,
      statusUntil:
        clearShown === 'keep' ? keptUntil : statusEnd(clearShown, new Date(minute), format),
    };
  };
  const wanted: UpdateProfileRequest = {
    ...Object.fromEntries(
      FIELDS.map((field) => [field, asked(field)] as const).filter(
        ([field, value]) => value !== undefined && value !== stored[field],
      ),
    ),
    ...wantedLine(),
  };
  const changed = Object.keys(wanted).length > 0;
  const busy = state === 'busy';

  const edit = (field: Field, value: string): void => {
    setEdited((now) => ({ ...now, [field]: value }));
    setState('idle');
  };

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (busy || !changed) return;
    setState('busy');
    setProblems({});
    let saved: Profile;
    try {
      // The end is worked out as Save is pressed, not when the choice was made.
      saved = await api.updateProfile({ ...wanted, ...wantedLine() });
    } catch (failure) {
      setState('idle');
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        const refused = (Object.keys(REFUSED) as (keyof typeof REFUSED)[]).filter(
          (field) => field in failure.fields,
        );
        setProblems(
          refused.length === 0
            ? { form: `${t('profile.saveFailed')} ${describe(failure)}` }
            : Object.fromEntries(refused.map((field) => [field, t(REFUSED[field])])),
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
    if (saved.timeZone !== profile.timeZone) profileTimeZoneChanged(client, saved.timeZone);
    setEdited({});
    setClear(undefined);
    setState('saved');
    // Wherever you are a member, your profile is read again — as the frame tells the others to.
    void client.invalidateQueries({ queryKey: families.members });
  };

  const errorOf = (field: Field | 'statusUntil'): { error: string } | Record<string, never> => {
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
            label={t('profile.emojiLabel')}
            hint={t('profile.emojiHint')}
            value={shown('statusEmoji')}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            {...errorOf('statusEmoji')}
            onChange={(event) => {
              edit('statusEmoji', event.target.value);
            }}
          />
          <SettingsRow
            label={t('profile.clearLabel')}
            description={problems.statusUntil ?? t('profile.clearHint')}
            fill
          >
            <Select
              aria-label={t('profile.clearLabel')}
              disabled={busy}
              value={clearShown}
              className="w-full"
              onChange={(event) => {
                const value = event.target.value;
                const chosen = value === 'keep' ? 'keep' : STATUS_CLEARS.find((c) => c === value);
                if (chosen !== undefined) {
                  setClear(chosen);
                  setState('idle');
                }
              }}
            >
              {keptUntil !== null && (
                <option value="keep">
                  {t('profile.statusUntil', { time: untilText(keptUntil, minute, format) })}
                </option>
              )}
              {STATUS_CLEARS.map((choice) => (
                <option key={choice} value={choice}>
                  {t(`profile.clear.${choice}`)}
                </option>
              ))}
            </Select>
          </SettingsRow>
          <SettingsTextRow
            readOnly={busy}
            label={t('profile.zoneLabel')}
            hint={t('profile.zoneHint')}
            value={shown('timeZone')}
            placeholder={deviceZone}
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
                disabled={busy}
                className="-ml-3"
                onClick={() => {
                  edit('timeZone', deviceZone);
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
