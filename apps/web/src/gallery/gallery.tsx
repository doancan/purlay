/**
 * Every primitive, every state, in both themes at once.
 *
 * Two uses, one page. A person reviewing a change to a primitive sees dark and
 * light side by side and cannot approve one while breaking the other; and the
 * browser test (#139) photographs this page, so a theme or a state cannot be added
 * to the product and missed by the visual snapshots — D-53's "every theme that
 * exists", made mechanical.
 *
 * **It is development only.** It is a lazy chunk the production build does not
 * contain unless asked (`app/outlet.tsx`), so its words are English literals: it
 * is never shipped, and a catalogue entry for a catalogue page would be a
 * translation nobody reads.
 *
 * **The themes sit side by side because the tokens are scoped.** Every colour is a
 * custom property declared on `[data-theme]`, so a `data-theme` on a section
 * re-themes that section alone. The overlays (dialog, menu, tooltip, toast) are the
 * exception: they render into a portal on `<body>` and take the *page's* theme;
 * they are live here, and the page's theme is the toggle at the top.
 */
import { colorTokens, cssVar } from '@purlay/tokens';
import { useState } from 'react';
import { Icon, glyphNames } from '../components/icon';
import { SettingsMenu } from '../features/shell/settings-menu';
import { Avatar } from '../ui/avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { IconButton } from '../ui/icon-button';
import { Kbd } from '../ui/kbd';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../ui/menu';
import { LoadingStatus, Skeleton } from '../ui/skeleton';
import { EmptyState, ErrorState } from '../ui/states';
import { TextField } from '../ui/text-field';
import { useToast } from '../ui/toast';

type SpecimenTheme = 'dark' | 'light';

/** What a gallery control does: nothing, on purpose — it is here to be looked at. */
const noop = (): void => undefined;

const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <section className="flex flex-col gap-3">
    <h2 className="text-label text-ink-muted">{title}</h2>
    {children}
  </section>
);

const Row = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <div className="flex flex-wrap items-center gap-2">{children}</div>
);

const TYPE_SAMPLES = [
  ['text-display', 'Display · An empty channel'],
  ['text-title', 'Title · backend-deploys'],
  ['text-heading', 'Heading · alice'],
  ['text-body', 'Body · The retry backoff is 4s because the upstream rate-limits.'],
  ['text-label', 'Label · Resolve'],
  ['text-caption', 'Caption · 14:32 · edited'],
  ['text-code', 'Code · git rebase -i HEAD~3'],
] as const;

/** One class per sample, spelled out, so the vocabulary check reads each one. */
const typeClasses = {
  'text-display': 'text-display text-ink',
  'text-title': 'text-title text-ink',
  'text-heading': 'text-heading text-ink',
  'text-body': 'text-body text-ink',
  'text-label': 'text-label text-ink',
  'text-caption': 'text-caption text-ink-muted',
  'text-code': 'text-code text-ink',
} as const;

const Specimen = (): React.JSX.Element => (
  <div className="flex flex-col gap-8">
    <Section title="Type">
      {TYPE_SAMPLES.map(([name, sample]) => (
        <p key={name} className={typeClasses[name]}>
          {sample}
        </p>
      ))}
      <p className="font-mono text-body text-ink">Channel names are mono: # api, # deploys</p>
      <p className="text-body font-semibold text-ink">Unread is bold</p>
    </Section>

    <Section title="Colour">
      <div className="grid grid-cols-2 gap-2">
        {colorTokens.map((name) => (
          <div key={name} className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-icon-lg shrink-0 rounded-sm border-hairline border-border-strong"
              style={{ backgroundColor: cssVar(name) }}
            />
            <span className="text-caption text-ink-muted">{name}</span>
          </div>
        ))}
      </div>
      <p className="text-body text-accent-text">A link is accent-text</p>
      <p className="text-body text-danger-text">Danger as text</p>
      <p className="text-body text-warning-text">Warning as text</p>
      <p className="text-body text-success-text">Success as text</p>
    </Section>

    <Section title="Buttons">
      <Row>
        <Button variant="primary" glyph="add">
          Primary
        </Button>
        <Button>Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
      </Row>
      <Row>
        <Button disabled>Disabled</Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
        <Button busy>Busy</Button>
      </Row>
    </Section>

    <Section title="Icon buttons, keys, badge">
      <Row>
        <IconButton label="Search" glyph="search" shortcut="⌘K" />
        <IconButton label="Close" glyph="close" />
        <IconButton label="Disabled" glyph="more" disabled />
        <Kbd>⌘K</Kbd>
        <Kbd>Shift+Enter</Kbd>
        <Badge count={2} label="2 unread mentions" />
        <Badge count={12} label="12 unread mentions" />
        <IconButton label="Inbox, on the rail" glyph="inbox" size="rail" />
      </Row>
    </Section>

    <Section title="Avatars and status pills">
      <Row>
        <Avatar name="Alice Chen" username="alice" size="sm" />
        <Avatar name="Alice Chen" username="alice" size="md" />
        <Avatar name="Alice Chen" username="alice" size="lg" />
        <Avatar name="Bob Okafor" username="bob" size="lg" />
        <Avatar name="Carol Reyes" username="carol" size="lg" />
        <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-warning-subtle px-2 text-caption font-medium text-warning-text">
          <Icon name="open-question" size="sm" />
          Open
        </span>
        <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-success-subtle px-2 text-caption font-medium text-success-text">
          <Icon name="resolved" size="sm" />
          Resolved
        </span>
        <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-danger-subtle px-2 text-caption font-medium text-danger-text">
          <Icon name="failed" size="sm" />
          Failed
        </span>
      </Row>
    </Section>

    <Section title="Icons">
      <div className="grid grid-cols-3 gap-3 text-ink">
        {glyphNames.map((name) => (
          <div key={name} className="flex items-center gap-2">
            <Icon name={name} size="sm" />
            <Icon name={name} />
            <Icon name={name} size="lg" />
            <span className="text-caption text-ink-muted">{name}</span>
          </div>
        ))}
      </div>
    </Section>

    <Section title="Fields">
      <TextField label="Name" placeholder="deploys" />
      <TextField label="Topic" hint="Optional. One line on what the channel is for." />
      <TextField label="Name" defaultValue="api" error="A channel with that name already exists." />
    </Section>

    <Section title="Loading, empty, failed">
      <LoadingStatus label="Loading messages" className="flex flex-col gap-3">
        <Skeleton className="w-members" />
        <Skeleton />
        <Skeleton className="w-feed" />
      </LoadingStatus>
      <EmptyState
        title="No messages yet"
        body="This channel is new. Say what it is for in the first message."
        action={<Button variant="primary">Write the first message</Button>}
      />
      <ErrorState
        title="Couldn't load messages"
        body="The server did not answer. Your draft is safe."
        retryLabel="Retry"
        onRetry={noop}
      />
    </Section>
  </div>
);

/** Overlays are live: they open over the page, in the page's theme. */
const Overlays = (): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const { show } = useToast();
  return (
    <Section title="Overlays (live, in the page theme)">
      <Row>
        <Button
          onClick={() => {
            setOpen(true);
          }}
        >
          Open dialog
        </Button>
        <Menu trigger={<Button glyph="person">Menu</Button>}>
          <MenuLabel>alice</MenuLabel>
          <MenuItem onSelect={noop} glyph="settings">
            Settings
          </MenuItem>
          <MenuItem onSelect={noop} glyph="shortcuts" shortcut="⌘/">
            Shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={noop} glyph="sign-out" tone="danger">
            Sign out
          </MenuItem>
        </Menu>
        <Button
          onClick={() => {
            show({
              message: 'Pasted text became a code block',
              actionLabel: 'Undo',
              onAction: noop,
            });
          }}
        >
          Show toast
        </Button>
        <SettingsMenu />
      </Row>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="New channel"
        description="Anyone in the workspace can find and join a public channel."
        closeLabel="Close"
        footer={
          <>
            <Button
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="primary">Create channel</Button>
          </>
        }
      >
        <TextField
          label="Name"
          placeholder="deploys"
          hint="Lowercase letters, numbers and hyphens."
        />
      </Dialog>
    </Section>
  );
};

const ThemeFrame = ({
  theme,
  children,
}: {
  readonly theme: SpecimenTheme;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <section
    data-theme={theme}
    aria-label={`${theme} theme`}
    className="flex min-w-0 flex-col gap-6 rounded-md border-hairline border-border-subtle bg-surface-100 p-6 text-ink"
  >
    <h2 className="text-title">{theme === 'dark' ? 'Dark' : 'Light'}</h2>
    {children}
  </section>
);

export const Gallery = (): React.JSX.Element => (
  <div className="flex flex-col gap-6 bg-surface-000 p-6">
    <header className="flex flex-col gap-1">
      <h1 className="text-display text-ink">Gallery</h1>
      <p className="max-w-feed text-body text-ink-muted">
        Every primitive and every state, in both themes at once. Development only: this page is not
        in the production build.
      </p>
    </header>
    <Overlays />
    <div className="grid grid-cols-2 gap-6 max-narrow:grid-cols-1">
      <ThemeFrame theme="dark">
        <Specimen />
      </ThemeFrame>
      <ThemeFrame theme="light">
        <Specimen />
      </ThemeFrame>
    </div>
  </div>
);
