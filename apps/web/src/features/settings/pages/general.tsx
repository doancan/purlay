/**
 * General (D-124, D-146), an owner's or an admin's: the workspace's name, its address, and the way to
 * another workspace.
 *
 * The address — the slug in every link already pasted — is shown, copied in one press, and does not
 * change with the name, so the page says so rather than leaving somebody to find out. Saved, the name
 * is everywhere in this tab at once (the server's answer goes into the session), and every other tab
 * of every member hears `WORKSPACE_UPDATED` and reads it again. What the server refuses comes back
 * under the field, and what was typed stays for a retry.
 */
import { WORKSPACE_NAME_MAX } from '@purlay/types';
import { useState } from 'react';
import { useActions } from '../../../data/actions-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { href } from '../../../router/routes';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { useToast } from '../../../ui/toast';
import { useContentPorts } from '../../content/content-ports';
import { useSession } from '../../session/session';
import { CreateWorkspace } from '../../shell/home';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard, SettingsPage, SettingsRow, SettingsTextRow } from '../page';

export const GeneralPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { copy } = useContentPorts();
  const { workspace } = useWorkspace();
  const { mayCreateWorkspace } = useSession();
  const { renameWorkspace } = useActions();
  // What was typed; until something is, the field shows the name as it is now, so a rename in
  // another tab appears here.
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  const [creating, setCreating] = useState(false);
  const name = typed ?? workspace.name;
  const changed = name.trim() !== workspace.name;
  const address = `${window.location.origin}${href('workspace', { slug: workspace.slug })}`;

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '') {
      setProblem(t('workspace.settings.empty'));
      return;
    }
    setState('busy');
    setProblem(null);
    try {
      await renameWorkspace(workspace.id, wanted);
      setTyped(null);
      setState('saved');
    } catch (failure) {
      setState('idle');
      setProblem(
        isApiError(failure) && failure.code === 'VALIDATION_FAILED'
          ? t('workspace.nameInvalid', { max: WORKSPACE_NAME_MAX })
          : `${t('workspace.settings.failed')} ${describe(failure)}`,
      );
    }
  };

  return (
    <SettingsPage
      title={t('settings.general.title')}
      description={t('settings.general.description')}
    >
      <form
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <SettingsCard
          title={t('settings.general.workspace')}
          footer={
            <>
              <SaveOutcome
                outcome={state === 'saved' ? { ok: true, words: t('profile.saved') } : null}
              />
              <Button type="submit" variant="primary" busy={state === 'busy'} disabled={!changed}>
                {t('workspace.settings.save')}
              </Button>
            </>
          }
        >
          <SettingsTextRow
            label={t('workspace.create.name')}
            hint={t('settings.general.nameHint')}
            value={name}
            maxLength={WORKSPACE_NAME_MAX}
            autoComplete="off"
            {...(problem === null ? {} : { error: problem })}
            onChange={(event) => {
              setTyped(event.target.value);
              setState('idle');
            }}
          />
          <SettingsRow
            label={t('settings.general.address')}
            description={t('settings.general.addressHint')}
            fill
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              {/* Cut with an ellipsis, said in full on hover: a flex box clips its words without one. */}
              <code
                title={address}
                className="flex h-control min-w-0 flex-1 items-center rounded-md border-hairline border-border-subtle bg-surface-000 px-3 font-mono text-caption text-ink max-narrow:h-touch"
              >
                <span className="truncate">{address}</span>
              </code>
              <Button
                glyph="copy"
                onClick={() => {
                  copy(address).then(
                    () => {
                      show({ message: t('common.copied') });
                    },
                    () => {
                      show({ message: t('failure.copy') });
                    },
                  );
                }}
              >
                {t('common.copy')}
              </Button>
            </span>
          </SettingsRow>
        </SettingsCard>
      </form>
      {/* Offered only to whom the server lets make one (D-155): never a form that would be refused. */}
      {mayCreateWorkspace && (
        <SettingsCard title={t('settings.general.another')}>
          <SettingsRow
            label={t('workspace.create.title')}
            description={t('settings.general.anotherHint')}
          >
            <Button
              glyph="add"
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('workspace.create.entry')}
            </Button>
          </SettingsRow>
        </SettingsCard>
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t('workspace.create.title')}
        description={t('workspace.create.body')}
        closeLabel={t('common.close')}
      >
        <CreateWorkspace
          framed={false}
          onCreated={() => {
            setCreating(false);
          }}
          onCancel={() => {
            setCreating(false);
          }}
        />
      </Dialog>
    </SettingsPage>
  );
};
