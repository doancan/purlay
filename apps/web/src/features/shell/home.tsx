/**
 * `/` — somewhere to go, or somewhere to start.
 *
 * A person with a workspace is sent to the first one (`replace`, so Back does not
 * land on a page that only redirects). A person with none sees why, and — because a
 * workspace is the one thing the API lets anybody create — a form to make the first.
 */
import { useDescribeFailure } from '../../data/failure';
import { useEffect, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** What a name suggests as an address: the part of it a URL would keep. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

const CreateWorkspace = (): React.JSX.Element => {
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
      navigate(href('workspace', { slug: workspace.slug }), { replace: true });
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'WORKSPACE_SLUG_TAKEN') {
        setError({ field: 'slug', message: t('workspace.create.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setError({ field: 'slug', message: t('workspace.create.invalid') });
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
      className="flex max-w-dialog flex-col gap-4"
    >
      <h2 className="text-title text-ink">{t('workspace.create.title')}</h2>
      <p className="text-body text-ink-muted">{t('workspace.create.body')}</p>
      <TextField
        label={t('workspace.create.name')}
        value={name}
        required
        maxLength={64}
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
  const { memberships } = useSession();
  const { navigate } = useRoute();
  const first = memberships[0]?.workspace.slug;

  useEffect(() => {
    if (first !== undefined) navigate(href('workspace', { slug: first }), { replace: true });
  }, [first, navigate]);

  if (first !== undefined) return null;
  return (
    <Main className="flex min-h-screen flex-col gap-6 bg-surface-100 px-4 py-8 text-ink">
      <section className="flex max-w-feed flex-col gap-2">
        <h1 className="text-display">{t('workspace.none.title')}</h1>
        <p className="text-body text-ink-muted">{t('workspace.none.body')}</p>
      </section>
      <CreateWorkspace />
    </Main>
  );
};
