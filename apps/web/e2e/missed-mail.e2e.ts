/**
 * Email about what a person missed, end to end (D-240, `UX.md` §11): on a server of its own with a real mail
 * relay that keeps what it took (`fresh.ts`), the administrator turns it on in Notifications; a teammate writes
 * to her; the scheduled job — the real `bun run job mail:missed`, a process of its own, reading the relay from
 * the server's settings — sends one letter, which quotes the message and links to it; a second run sends
 * nothing; the letter's stop link, opened in a browser with nobody signed in, turns it off, and Notifications
 * says so.
 *
 * The quarter hour a notification waits is not waited for: the rows are moved back in time in the scratch
 * database, the one thing done behind the application's back.
 */
import { spawnSync } from 'node:child_process';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { messageId } from '@purlay/types';
import { letterWith, linkIn, portFor, startFresh, type FreshServer } from './fresh';
import { wallClock } from './support';

const PORT = portFor(60);
const PASSWORD = 'a long and unusual phrase 7';
/** The key `fresh-server.ts` starts its API with: the job must open the relay's sealed address with it. */
const DEVELOPMENT_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';
const EMAIL_SETTING = 'Email me about direct messages and mentions I haven’t read';

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light-narrow', 'one run proves the path');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

const posting =
  (request: APIRequestContext, origin: string) =>
  async <T>(path: string, data?: unknown): Promise<T> => {
    const response = await request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
    const text = await response.text();
    return (text === '' ? null : JSON.parse(text)) as T;
  };

/** A process of its own at the repository's root, as the scheduler runs one, against the fresh server. */
const runFromRoot = (args: readonly string[], env: Record<string, string>): number => {
  const ran = spawnSync('bun', ['--no-env-file', ...args], {
    cwd: '../..',
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (ran.status !== 0) throw new Error(`${args.join(' ')}: ${ran.stdout}\n${ran.stderr}`);
  return ran.status;
};

test('turned on in Notifications, one letter about a direct message, and its link stops it', async ({
  browser,
}) => {
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, github, relay, mailbox, database } = fresh.manifest;

  // The server, set up with a relay, by its administrator — whose address the relay's letter verifies.
  const ada = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const asAda = posting(ada.request, origin);
  await asAda('/setup/claim', { code });
  await asAda('/setup/admin', {
    name: 'Ada Yılmaz',
    email: 'ada@example.test',
    password: PASSWORD,
  });
  await asAda('/setup/address', { confirmed: true });
  await asAda('/setup/policy', { signUp: 'invite-only' });
  await asAda('/setup/github', {
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    save: true,
  });
  await asAda('/setup/smtp', {
    smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
    from: 'no-reply@example.test',
    allowPlaintext: true,
    locale: 'en',
    save: true,
  });
  const verify = linkIn(
    await letterWith(mailbox, /Confirm your address/),
    /\/setup\/verify#[0-9a-f]{64}/,
  );
  await asAda('/setup/verify', { token: verify.split('#')[1] });
  await asAda('/setup/workspace', { name: 'Kokil Metal', slug: 'kokil-metal' });
  await asAda('/setup/invite');
  await asAda('/setup/finish');
  const me = (await (await ada.request.get('/api/me')).json()) as {
    user: { id: string };
    memberships: { workspace: { id: string } }[];
  };
  const workspaceId = me.memberships[0]?.workspace.id ?? '';

  // Ayşe joins by an invitation link and an emailed sign-in link.
  const { token: invitation } = await asAda<{ token: string }>(
    `/api/workspaces/${workspaceId}/invitations`,
    {},
  );
  const ayse = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const asAyse = posting(ayse.request, origin);
  await asAyse('/api/invitations/passport', { token: invitation, email: 'ayse@example.test' });
  await asAyse('/auth/email', { email: 'ayse@example.test', locale: 'en' });
  const signIn = linkIn(
    await letterWith(mailbox, /Your sign-in link/),
    /\/sign-in\/email#[0-9A-Za-z_-]+/,
  );
  await asAyse('/auth/email/consume', { token: signIn.split('#')[1] });
  await asAyse('/api/invitations/accept', { token: invitation });

  // Ada turns it on, where the page offers it because this server has a relay.
  const page = await ada.newPage();
  await page.goto('/w/kokil-metal/settings/notifications');
  const card = page.getByRole('region', { name: 'Email' });
  const box = card.getByRole('checkbox', { name: EMAIL_SETTING });
  await expect(box).not.toBeChecked();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/me/missed-mail') && response.request().method() === 'PUT',
  );
  await box.check();
  expect((await saved).status()).toBe(200);

  // Ayşe writes to her, and Ada does not read it.
  const dm = await asAyse<{ id: string }>(`/api/workspaces/${workspaceId}/dms`, {
    userId: me.user.id,
  });
  const sentId = messageId(wallClock());
  await asAyse(`/api/channels/${dm.id}/messages`, {
    id: sentId,
    content: 'Merhaba Ada, deploy **kırmızı** — bakar mısın?',
  });

  // A quarter of an hour passes, as far as the job can tell; then the job runs as the scheduler runs it.
  const environment = {
    NODE_ENV: 'development',
    LOG_LEVEL: 'warn',
    APP_URL: origin,
    DATABASE_URL: database,
    ENCRYPTION_KEY: DEVELOPMENT_KEY,
  };
  runFromRoot(
    [
      '-e',
      `const sql = new Bun.SQL(process.env.DATABASE_URL);
       await sql\`update users set missed_mail_since = missed_mail_since - interval '1 hour' where missed_mail_since is not null\`;
       await sql\`update notifications set created_at = created_at - interval '20 minutes' where mailed_at is null\`;
       await sql.close();`,
    ],
    environment,
  );
  runFromRoot(['apps/api/src/cli/jobs.ts', 'mail:missed'], environment);

  const letter = await letterWith(mailbox, /Messages are waiting for you on Purlay/);
  expect(letter.to).toEqual(['ada@example.test']);
  // A direct message is named by who wrote it: her name made from her address, as nobody has set one.
  expect(letter.text).toContain('Kokil Metal\nayse — 1 message');
  expect(letter.text).toContain('ayse: “Merhaba Ada, deploy kırmızı — bakar mısın?”');
  const link = linkIn(letter, new RegExp(`/w/kokil-metal/c/${dm.id}\\?message=${sentId}`));
  await page.goto(link);
  await expect(page.getByText('Merhaba Ada, deploy')).toBeVisible();

  // Run again: the same message is never mailed twice.
  runFromRoot(['apps/api/src/cli/jobs.ts', 'mail:missed'], environment);
  await expect(letterWith(mailbox, /Messages are waiting for you on Purlay/, 1)).rejects.toThrow();

  // The stop link, in a browser with nobody signed in: it asks first, then stops it.
  const stop = linkIn(letter, /\/mail\/stop#[0-9a-f]{64}/);
  const stranger = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const reading = await stranger.newPage();
  await reading.goto(stop);
  await expect(reading.getByRole('heading', { name: 'Stop these emails?' })).toBeVisible();
  // The token leaves the address bar once the page has read it.
  await expect.poll(() => new URL(reading.url()).hash).toBe('');
  await reading.getByRole('button', { name: 'Stop these emails' }).click();
  await expect(
    reading.getByRole('heading', { name: 'You won’t get these emails any more' }),
  ).toBeVisible();
  await stranger.close();

  await page.goto('/w/kokil-metal/settings/notifications');
  await expect(
    page.getByRole('region', { name: 'Email' }).getByRole('checkbox', { name: EMAIL_SETTING }),
  ).not.toBeChecked();
  await ayse.close();
  await ada.close();
});
