/**
 * `/` — somewhere to go, or somewhere to start.
 *
 * A person with a workspace is sent to the first one (`replace`, so Back does not
 * land on a page that only redirects). A person with none sees why, on a card with the product's
 * mark like the sign-in screen it follows (D-100): with a form to make the first where this server
 * would let them, and otherwise told to ask for an invitation — never a form that would be refused
 * (D-155). The same form is the workspace menu's **Create workspace…**, for a person who has one
 * already and may make another (D-124).
 */
import { WORKSPACE_NAME_MAX } from '@purlay/types';
import { useDescribeFailure } from '../../data/failure';
import { useEffect, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { LogoMark } from './notice';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';
import { browserInvitationPorts, pendingInvitation } from '../invitations/pending';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** What a name suggests as an address: the part of it a URL would keep. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

interface CreateWorkspaceProps {
  /** In a dialog, which says what it is for: the form is drawn without its own heading. */
  readonly framed?: boolean;
  /** Made: the dialog closes. The page goes to the new workspace either way. */
  readonly onCreated?: () => void;
}

export const CreateWorkspace = ({
  framed = true,
  onCreated,
}: CreateWorkspaceProps): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { createWorkspace } = useActions();
  const { navigate } = useRoute();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'slug' | 'form'; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const address = edited ? slug : slugOf(name);

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!SLUG.test(address)) {
      setError({ field: 'slug', message: t('workspace.create.invalid') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const workspace = await createWorkspace({ name: name.trim(), slug: address });
      onCreated?.();
      // From `/`, which only ever redirects, Back must not return there; from a workspace it may.
      navigate(href('workspace', { slug: workspace.slug }), { replace: framed });
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'FORBIDDEN') {
        // The server's rule moved under the form — the first workspace made a moment ago (D-155).
        setError({ field: 'form', message: t('workspace.create.notAllowed') });
      } else if (isApiError(failure) && failure.code === 'WORKSPACE_SLUG_TAKEN') {
        setError({ field: 'slug', message: t('workspace.create.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        // Said under the field the server named: a refused name is not an address problem.
        setError(
          'name' in failure.fields
            ? { field: 'name', message: t('workspace.nameInvalid', { max: WORKSPACE_NAME_MAX }) }
            : { field: 'slug', message: t('workspace.create.invalid') },
        );
      } else {
        setError({
          field: 'form',
          message: `${t('workspace.create.failed')} ${describe(failure)}`,
        });
      }
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className={
        framed
          ? 'flex flex-col gap-4 border-t-hairline border-border-subtle pt-6'
          : 'flex flex-col gap-4'
      }
    >
      {framed && (
        <>
          <h2 className="text-title text-ink">{t('workspace.create.title')}</h2>
          <p className="text-body text-ink-muted">{t('workspace.create.body')}</p>
        </>
      )}
      <TextField
        label={t('workspace.create.name')}
        value={name}
        required
        maxLength={WORKSPACE_NAME_MAX}
        {...(error?.field === 'name' ? { error: error.message } : {})}
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label={t('workspace.create.slug')}
        hint={t('workspace.create.slugHint')}
        value={address}
        required
        maxLength={64}
        autoComplete="off"
        spellCheck={false}
        {...(error?.field === 'slug' ? { error: error.message } : {})}
        onChange={(event) => {
          setEdited(true);
          setSlug(event.target.value);
        }}
      />
      {error?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {error.message}
        </p>
      )}
      <div>
        <Button type="submit" variant="primary" busy={busy}>
          {t('workspace.create.submit')}
        </Button>
      </div>
    </form>
  );
};

export const Home = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { memberships, mayCreateWorkspace } = useSession();
  const { navigate } = useRoute();
  const first = memberships[0]?.workspace.slug;
  // Back from signing in with an invitation in hand: that is where the person was going (D-115).
  const [invited] = useState(
    () => pendingInvitation(browserInvitationPorts(), window.location) !== null,
  );

  useEffect(() => {
    if (invited) navigate(href('invite'), { replace: true });
    else if (first !== undefined) navigate(href('workspace', { slug: first }), { replace: true });
  }, [invited, first, navigate]);

  if (invited || first !== undefined) return null;
  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <div className="flex w-full max-w-dialog flex-col gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 shadow-card">
        <LogoMark />
        {mayCreateWorkspace ? (
          <>
            <section className="flex flex-col gap-2">
              <h1 className="text-display">{t('workspace.none.title')}</h1>
              <p className="text-body text-ink-muted">{t('workspace.none.body')}</p>
            </section>
            <CreateWorkspace />
          </>
        ) : (
          <section className="flex flex-col gap-2">
            <h1 className="text-display">{t('workspace.closed.title')}</h1>
            <p className="text-body text-ink-muted">{t('workspace.closed.body')}</p>
          </section>
        )}
      </div>
    </Main>
  );
};
