/**
 * The person's name, where it is theirs to set (D-235): an account that signed up by a link, by single
 * sign-on or with a password starts with a name made from its address, and changes it here. An account
 * GitHub made takes its name from GitHub at every sign-in, so this row is not offered for it.
 *
 * Its own Save, beside the field: the name is who you are to everyone, not one of the lines about you
 * below. Saved, it is drawn at once in this tab and every member list reads it again.
 */
import { DISPLAY_NAME_MAX, type MeResponse } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { families, keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { useSession } from '../../session/session';
import { SaveOutcome, SettingsTextRow } from '../page';

export const NameRow = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { user } = useSession();
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; words: string } | null>(null);

  const shown = typed ?? user.displayName;
  const wanted = shown.trim();
  const changed = typed !== null && wanted !== '' && wanted !== user.displayName;

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    try {
      await api.updateProfile({ displayName: wanted });
      client.setQueryData<MeResponse>(keys.me, (me) =>
        me === undefined ? me : { ...me, user: { ...me.user, displayName: wanted } },
      );
      setTyped(null);
      setOutcome({ ok: true, words: t('profile.saved') });
      void client.invalidateQueries({ queryKey: families.members });
    } catch (failure) {
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem(t('profile.wordsInvalid'));
      } else {
        setOutcome({ ok: false, words: `${t('profile.saveFailed')} ${describe(failure)}` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <SettingsTextRow
        readOnly={busy}
        label={t('profile.nameLabel')}
        hint={t('profile.nameHint')}
        value={shown}
        maxLength={DISPLAY_NAME_MAX}
        autoComplete="name"
        {...(problem === null ? {} : { error: problem })}
        onChange={(event) => {
          setTyped(event.target.value);
          setOutcome(null);
        }}
      />
      <div className="flex items-center justify-end gap-3 px-6 pb-5 max-narrow:px-4">
        <SaveOutcome outcome={outcome} />
        <Button type="submit" busy={busy} disabled={!changed}>
          {t('profile.saveName')}
        </Button>
      </div>
    </form>
  );
};
