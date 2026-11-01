/**
 * The operator's settings in the database (D-179 §6): read and written whole, the secrets sealed to
 * their own column and never in a view, and the environment imported once — by two processes at once
 * as well as by one.
 *
 * Inside a rolled-back transaction (D-46), but for the race, which needs two connections that see each
 * other and so a database of its own (`cloneIntegrationDatabase`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type Executor,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher, SealBroken } from '../../platform/crypto';
import { testConfig } from '../../testing/doubles';
import {
  envSeedOf,
  ignoredEnvironment,
  importFromEnvOnce,
  readSettings,
  readSettingsToBoot,
  readWorkspaceCreators,
  saveSettings,
  settingsView,
  type SettingsSeed,
} from './settings';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-10-22T09:00:00.000Z'));
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);

const GITHUB = { clientId: 'Iv1.app-id', clientSecret: 'gh-secret-0f3a9c' };
const SMTP = {
  smtpUrl: 'smtps://purlay%40example.com:relay-pw-77z@mail.example.com:465',
  from: 'purlay@example.com',
  allowPlaintext: false,
};

/** The row as stored, secrets and all: what a dump of the database holds. */
const rawRow = async (
  db: Executor,
): Promise<{ github: string | null; smtp: string | null; imported: Date | null }> => {
  const row = await db
    .selectFrom('server_settings')
    .select([
      'github_client_secret_encrypted as github',
      'smtp_url_encrypted as smtp',
      'imported_from_env_at as imported',
    ])
    .where('id', '=', true)
    .executeTakeFirstOrThrow();
  return row;
};

const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
};

describe('integration: the server settings (D-179 §6)', () => {
  test('a server with no row reads the defaults: invite-only, no GitHub, no mail, the first person, not set up', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      expect(await readSettings(db, cipher)).toEqual({
        signUp: 'invite-only',
        github: undefined,
        oidc: undefined,
        smtp: undefined,
        workspaceCreators: { kind: 'first' },
        setupCompletedAt: undefined,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      });
    });
  });

  test('what is saved is what is read back', async () => {
    await withRollback(async (db) => {
      const finished = new Date('2026-10-21T08:00:00.000Z');
      await saveSettings(db, cipher, clock, {
        signUp: 'open',
        github: GITHUB,
        oidc: undefined,
        smtp: SMTP,
        workspaceCreators: { kind: 'listed', logins: new Set(['Ada', 'grace-h']) },
        setupCompletedAt: finished,
      });
      expect(await readSettings(db, cipher)).toEqual({
        signUp: 'open',
        github: GITHUB,
        oidc: undefined,
        smtp: SMTP,
        // Lower case, as a login is compared (D-169).
        workspaceCreators: { kind: 'listed', logins: new Set(['ada', 'grace-h']) },
        setupCompletedAt: finished,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      });
    });
  });

  test('stores the client secret encrypted and never returns it', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { github: GITHUB });
      const { github } = await rawRow(db);
      expect(github).not.toBeNull();
      expect(github).not.toContain(GITHUB.clientSecret);
      expect(Buffer.from(github ?? '', 'base64').toString('utf8')).not.toContain(
        GITHUB.clientSecret,
      );
      // It opens under its own column, and under no other.
      const sealed = Buffer.from(github ?? '', 'base64');
      expect(await cipher.open(sealed, 'server_settings.github_client_secret_encrypted')).toBe(
        GITHUB.clientSecret,
      );
      expect(
        await failure(cipher.open(sealed, 'server_settings.smtp_url_encrypted')),
      ).toBeInstanceOf(SealBroken);

      const view = settingsView(await readSettings(db, cipher));
      expect(view.github).toEqual({ clientId: GITHUB.clientId, clientSecret: { set: true } });
      expect(JSON.stringify(view)).not.toContain(GITHUB.clientSecret);
    });
  });

  test('stores the mail relay’s address encrypted, and shows only where it is', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { smtp: SMTP });
      const { smtp } = await rawRow(db);
      expect(smtp).not.toContain('relay-pw-77z');
      expect(smtp).not.toContain('mail.example.com');
      const sealed = Buffer.from(smtp ?? '', 'base64');
      expect(await cipher.open(sealed, 'server_settings.smtp_url_encrypted')).toBe(SMTP.smtpUrl);
      expect(
        await failure(cipher.open(sealed, 'server_settings.github_client_secret_encrypted')),
      ).toBeInstanceOf(SealBroken);

      const view = settingsView(await readSettings(db, cipher));
      expect(view.smtp).toEqual({
        address: { set: true, host: 'smtps://mail.example.com:465' },
        from: SMTP.from,
        allowPlaintext: false,
      });
      expect(JSON.stringify(view)).not.toContain('relay-pw-77z');
      expect(JSON.stringify(view)).not.toContain('purlay%40example.com');
    });
  });

  test('a sealed secret copied into the other column does not open there, and the read says so', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { github: GITHUB, smtp: SMTP });
      const { github } = await rawRow(db);
      await db.updateTable('server_settings').set({ smtp_url_encrypted: github }).execute();
      expect(await failure(readSettings(db, cipher))).toBeInstanceOf(SealBroken);
    });
  });

  test('a secret sealed under another key does not open, and the read says so', async () => {
    await withRollback(async (db) => {
      const other = credentialCipher(
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      );
      await saveSettings(db, other, clock, { github: GITHUB });
      expect(await failure(readSettings(db, cipher))).toBeInstanceOf(SealBroken);
    });
  });

  describe('read to start (R38): a secret that does not open is unset and named, never an exit', () => {
    const rotated = credentialCipher(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    );

    test('a rotated key leaves GitHub and the relay unset, named, and the row untouched', async () => {
      await withRollback(async (db) => {
        await saveSettings(db, cipher, clock, {
          github: GITHUB,
          smtp: SMTP,
          signUp: 'open',
          workspaceCreators: { kind: 'anyone' },
        });
        const before = await rawRow(db);
        const booted = await readSettingsToBoot(db, rotated);
        expect(booted.needsReentry).toEqual(['github', 'smtp']);
        expect(booted.settings).toEqual({
          signUp: 'open',
          github: undefined,
          oidc: undefined,
          smtp: undefined,
          workspaceCreators: { kind: 'anyone' },
          setupCompletedAt: undefined,
          requireTwoFactor: false,
          passwordSignIn: true,
          sessionIdleTimeoutHours: null,
          sessionMaxAgeDays: null,
        });
        // Nothing was deleted or rewritten: the ciphertext waits for a new value to replace it.
        expect(await rawRow(db)).toEqual(before);
        const row = await db
          .selectFrom('server_settings')
          .select(['github_client_id', 'mail_from'])
          .where('id', '=', true)
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ github_client_id: GITHUB.clientId, mail_from: SMTP.from });
        // The strict read still says so: it is the one a saved setting is checked with.
        expect(await failure(readSettings(db, rotated))).toBeInstanceOf(SealBroken);
      });
    });

    test('only the secret that fails is named; the other is read as it was', async () => {
      await withRollback(async (db) => {
        await saveSettings(db, cipher, clock, { github: GITHUB });
        await saveSettings(db, rotated, clock, { smtp: SMTP });
        const booted = await readSettingsToBoot(db, cipher);
        expect(booted.needsReentry).toEqual(['smtp']);
        expect(booted.settings.github).toEqual(GITHUB);
        expect(booted.settings.smtp).toBeUndefined();
      });
    });

    test('a key that opens everything names nothing, and a server with no row names nothing', async () => {
      await withRollback(async (db) => {
        await db.deleteFrom('server_settings').execute();
        expect((await readSettingsToBoot(db, cipher)).needsReentry).toEqual([]);
        await saveSettings(db, cipher, clock, { github: GITHUB, smtp: SMTP });
        const booted = await readSettingsToBoot(db, cipher);
        expect(booted.needsReentry).toEqual([]);
        expect(booted.settings.github).toEqual(GITHUB);
      });
    });

    test('a value that is no ciphertext at all is a broken seal too', async () => {
      await withRollback(async (db) => {
        await saveSettings(db, cipher, clock, { github: GITHUB });
        await db
          .updateTable('server_settings')
          .set({ github_client_secret_encrypted: 'not-a-ciphertext' })
          .execute();
        expect((await readSettingsToBoot(db, cipher)).needsReentry).toEqual(['github']);
      });
    });

    test('any other failure of the read is thrown, as it always was: only a seal that will not open is forgiven', async () => {
      await withRollback(async (db) => {
        await saveSettings(db, cipher, clock, { github: GITHUB });
        const failing = {
          ...cipher,
          open: (): Promise<string> => Promise.reject(new Error('the cipher itself failed')),
        };
        expect(await failure(readSettingsToBoot(db, failing))).toEqual(
          new Error('the cipher itself failed'),
        );
      });
    });
  });

  test('a patch changes what it names: left out is left alone, null clears', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, {
        github: GITHUB,
        smtp: SMTP,
        workspaceCreators: { kind: 'anyone' },
      });
      await saveSettings(db, cipher, clock, { signUp: 'open' });
      expect(await readSettings(db, cipher)).toMatchObject({
        signUp: 'open',
        github: GITHUB,
        oidc: undefined,
        smtp: SMTP,
        workspaceCreators: { kind: 'anyone' },
      });

      await saveSettings(db, cipher, clock, { github: null });
      const cleared = await readSettings(db, cipher);
      expect(cleared.github).toBeUndefined();
      expect(cleared.smtp).toEqual(SMTP);
      expect((await rawRow(db)).github).toBeNull();

      await saveSettings(db, cipher, clock, { smtp: null });
      const after = await readSettings(db, cipher);
      expect(after.smtp).toBeUndefined();
      expect(after.signUp).toBe('open');
    });
  });

  test('never unfinishes a setup: a patch clearing the finish is refused by the type and by the server', async () => {
    await withRollback(async (db) => {
      const finished = new Date('2026-10-22T08:00:00.000Z');
      await saveSettings(db, cipher, clock, { setupCompletedAt: finished });
      const refused = await failure(
        // @ts-expect-error -- only the finish rule writes it, and never back to empty
        saveSettings(db, cipher, clock, { setupCompletedAt: null }),
      );
      expect(String(refused)).toContain('a finished setup');
      expect((await readSettings(db, cipher)).setupCompletedAt).toEqual(finished);
    });
  });

  test('refuses a half of a pair, an empty list of creators and a login GitHub would not give', async () => {
    await withRollback(async (db) => {
      for (const patch of [
        { github: { clientId: '', clientSecret: 'x' } },
        { github: { clientId: 'x', clientSecret: '' } },
        { smtp: { ...SMTP, smtpUrl: 'https://mail.example.com' } },
        // Addresses the transport could not be built from: an unescaped `#`, a broken escape, half
        // the credentials, no host.
        { smtp: { ...SMTP, smtpUrl: 'smtp://u:pa#ss@mail.example.com' } },
        { smtp: { ...SMTP, smtpUrl: 'smtps://u:pa%zz@mail.example.com' } },
        { smtp: { ...SMTP, smtpUrl: 'smtps://u:@mail.example.com' } },
        { smtp: { ...SMTP, smtpUrl: 'smtp://' } },
        { smtp: { ...SMTP, from: '' } },
        { smtp: { ...SMTP, from: 'not an address' } },
        { workspaceCreators: { kind: 'listed' as const, logins: new Set<string>() } },
        { workspaceCreators: { kind: 'listed' as const, logins: new Set(['not a login']) } },
      ]) {
        // Refused by the module, before a statement is sent: the database's own checks are the second
        // lock, and a guard that leaned on them would let through what they do not cover.
        const refused = await failure(saveSettings(db, cipher, clock, patch));
        expect(refused).toBeInstanceOf(Error);
        expect({ patch, byTheDatabase: String(refused).includes('violates') }).toEqual({
          patch,
          byTheDatabase: false,
        });
      }
      // And the database refuses a half-written pair whoever writes it.
      await saveSettings(db, cipher, clock, {});
      expect(
        await failure(
          db.updateTable('server_settings').set({ github_client_id: 'only-the-id' }).execute(),
        ),
      ).toBeInstanceOf(Error);
    });
  });

  test('the database refuses a relay with an empty sender, whoever writes it', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { smtp: SMTP });
      const refused = await failure(
        db.updateTable('server_settings').set({ mail_from: '' }).where('id', '=', true).execute(),
      );
      expect(String(refused)).toContain('server_settings_mail_from');
    });
  });

  test('a second row cannot exist', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, {});
      expect(
        await failure(db.insertInto('server_settings').values({ id: false }).execute()),
      ).toBeInstanceOf(Error);
    });
  });

  test('who may make a workspace is read from the setting', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      expect(await readWorkspaceCreators(db)).toEqual({ kind: 'first' });
      await saveSettings(db, cipher, clock, {
        workspaceCreators: { kind: 'listed', logins: new Set(['Ada']) },
      });
      expect(await readWorkspaceCreators(db)).toEqual({
        kind: 'listed',
        logins: new Set(['ada']),
      });
      await saveSettings(db, cipher, clock, { workspaceCreators: { kind: 'anyone' } });
      expect(await readWorkspaceCreators(db)).toEqual({ kind: 'anyone' });
    });
  });
});

const SEED: SettingsSeed = envSeedOf(
  testConfig({
    GITHUB_CLIENT_ID: GITHUB.clientId,
    GITHUB_CLIENT_SECRET: GITHUB.clientSecret,
    SMTP_URL: SMTP.smtpUrl,
    MAIL_FROM: SMTP.from,
    SMTP_ALLOW_PLAINTEXT: true,
    WORKSPACE_CREATORS: 'Ada, grace',
  }),
);

describe('integration: the environment is imported once (D-179 §6)', () => {
  test('the first start copies the environment in; every later one leaves the row alone', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      expect(await importFromEnvOnce(db, cipher, clock, SEED)).toBe('imported');
      const imported = await readSettings(db, cipher);
      expect(imported).toEqual({
        signUp: 'invite-only',
        github: GITHUB,
        oidc: undefined,
        smtp: { ...SMTP, allowPlaintext: true },
        workspaceCreators: { kind: 'listed', logins: new Set(['ada', 'grace']) },
        setupCompletedAt: undefined,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      });
      expect((await rawRow(db)).imported).toEqual(clock.now());

      // The operator edits the environment and restarts: nothing changes.
      const changed = envSeedOf(
        testConfig({ GITHUB_CLIENT_ID: 'another', GITHUB_CLIENT_SECRET: 'another-secret' }),
      );
      expect(await importFromEnvOnce(db, cipher, clock, changed)).toBe('already');
      expect(await readSettings(db, cipher)).toEqual(imported);

      // Nor after a change made in the browser.
      await saveSettings(db, cipher, clock, { github: null, signUp: 'open' });
      expect(await importFromEnvOnce(db, cipher, clock, SEED)).toBe('already');
      expect(await readSettings(db, cipher)).toMatchObject({ github: undefined, signUp: 'open' });
    });
  });

  test('an environment that names only some settings leaves the rest at their defaults', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      const config = testConfig({ SMTP_ALLOW_PLAINTEXT: true });
      delete config.WORKSPACE_CREATORS;
      expect(await importFromEnvOnce(db, cipher, clock, envSeedOf(config))).toBe('imported');
      expect(await readSettings(db, cipher)).toEqual({
        signUp: 'invite-only',
        github: { clientId: 'client-id', clientSecret: 'client-secret' },
        oidc: undefined,
        // A plaintext permission with no relay is nothing to keep.
        smtp: undefined,
        workspaceCreators: { kind: 'first' },
        setupCompletedAt: undefined,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      });
    });
  });

  test('a relay address no transport can be built from is never stored, and the corrected one is imported', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      const broken: SettingsSeed = {
        ...SEED,
        smtp: {
          smtpUrl: 'smtp://u:pa#ss@mail.example.com',
          from: 'a@example.com',
          allowPlaintext: false,
        },
      };
      const refused = await failure(importFromEnvOnce(db, cipher, clock, broken));
      expect(refused).toBeInstanceOf(Error);
      expect(String(refused)).not.toContain('pa#ss');
      // Nothing committed, so nothing to stop a corrected start from importing.
      expect(
        await db.selectFrom('server_settings').select('id').where('id', '=', true).execute(),
      ).toEqual([]);
      const corrected: SettingsSeed = {
        ...SEED,
        smtp: {
          smtpUrl: 'smtp://u:pa%23ss@mail.example.com',
          from: 'a@example.com',
          allowPlaintext: false,
        },
      };
      expect(await importFromEnvOnce(db, cipher, clock, corrected)).toBe('imported');
      expect((await readSettings(db, cipher)).smtp?.smtpUrl).toBe(
        'smtp://u:pa%23ss@mail.example.com',
      );
    });
  });

  test('an environment with nothing to import still closes the import', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      expect(
        await importFromEnvOnce(db, cipher, clock, { workspaceCreators: { kind: 'first' } }),
      ).toBe('imported');
      expect(await importFromEnvOnce(db, cipher, clock, SEED)).toBe('already');
      expect((await readSettings(db, cipher)).github).toBeUndefined();
    });
  });
});

describe('integration: two processes starting at once import once', () => {
  test('neither waits on the other for ever, and exactly one copies its environment in', async () => {
    const clone = await cloneIntegrationDatabase();
    // Two connections of the clone's pool, each in a transaction of its own: neither sees the other's
    // until it commits, as two processes do.
    const first = clone.db;
    const second = clone.db;
    try {
      const seedOf = (id: string): SettingsSeed => ({
        github: { clientId: id, clientSecret: `${id}-secret` },
        workspaceCreators: { kind: 'first' },
      });
      for (let round = 0; round < 20; round += 1) {
        await clone.db.deleteFrom('server_settings').execute();
        // Half the rounds start with the row already there and never imported — a process that died
        // between making it and filling it — where only the row's lock keeps the two apart.
        if (round % 2 === 1)
          await clone.db.insertInto('server_settings').values({ id: true }).execute();
        const outcomes = await Promise.all([
          importFromEnvOnce(first, cipher, clock, seedOf('first')),
          importFromEnvOnce(second, cipher, clock, seedOf('second')),
        ]);
        expect([...outcomes].sort()).toEqual(['already', 'imported']);
        const winner = outcomes[0] === 'imported' ? 'first' : 'second';
        expect((await readSettings(clone.db, cipher)).github).toEqual({
          clientId: winner,
          clientSecret: `${winner}-secret`,
        });
        expect(
          await clone.db
            .selectFrom('server_settings')
            .select('id')
            .where('id', '=', true)
            .execute(),
        ).toHaveLength(1);
      }
    } finally {
      await clone.drop();
    }
  }, 30_000);
});

describe('integration: the single sign-on settings (D-200)', () => {
  const OIDC = {
    issuer: 'https://login.example.com/tenant-1',
    clientId: 'purlay-client',
    clientSecret: 'sso-secret-c19e42',
    name: 'Acme SSO',
  };

  const sealedColumn = async (db: Executor): Promise<string | null> =>
    (
      await db
        .selectFrom('server_settings')
        .select('oidc_client_secret_encrypted')
        .where('id', '=', true)
        .executeTakeFirstOrThrow()
    ).oidc_client_secret_encrypted;

  test('a provider is saved whole and read back, the issuer exactly as written', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { oidc: OIDC });
      expect((await readSettings(db, cipher)).oidc).toEqual(OIDC);
      // Without a label the default is the client's to word: stored as nothing.
      await saveSettings(db, cipher, clock, { oidc: { ...OIDC, name: undefined } });
      expect((await readSettings(db, cipher)).oidc).toEqual({ ...OIDC, name: undefined });
      expect(settingsView(await readSettings(db, cipher)).oidc?.name).toBeNull();
      // A trailing slash is part of the issuer: a token's `iss` is compared byte for byte.
      await saveSettings(db, cipher, clock, { oidc: { ...OIDC, issuer: `${OIDC.issuer}/` } });
      expect((await readSettings(db, cipher)).oidc?.issuer).toBe(`${OIDC.issuer}/`);
    });
  });

  test('stores the client secret encrypted, under its own column, and never returns it', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { oidc: OIDC });
      const stored = await sealedColumn(db);
      expect(stored).not.toBeNull();
      expect(stored).not.toContain(OIDC.clientSecret);
      expect(Buffer.from(stored ?? '', 'base64').toString('utf8')).not.toContain(OIDC.clientSecret);
      const sealed = Buffer.from(stored ?? '', 'base64');
      expect(await cipher.open(sealed, 'server_settings.oidc_client_secret_encrypted')).toBe(
        OIDC.clientSecret,
      );
      expect(
        await failure(cipher.open(sealed, 'server_settings.github_client_secret_encrypted')),
      ).toBeInstanceOf(SealBroken);
      const view = settingsView(await readSettings(db, cipher));
      expect(view.oidc).toEqual({
        issuer: OIDC.issuer,
        clientId: OIDC.clientId,
        clientSecret: { set: true },
        name: OIDC.name,
      });
      expect(JSON.stringify(view)).not.toContain(OIDC.clientSecret);
    });
  });

  test('a sealed secret copied into GitHub’s column does not open there', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { oidc: OIDC, github: GITHUB });
      await db
        .updateTable('server_settings')
        .set({ github_client_secret_encrypted: await sealedColumn(db) })
        .execute();
      expect(await failure(readSettings(db, cipher))).toBeInstanceOf(SealBroken);
    });
  });

  test('a secret sealed under another key is read as unset and named, the row untouched', async () => {
    await withRollback(async (db) => {
      const other = credentialCipher(
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      );
      await saveSettings(db, other, clock, { oidc: OIDC });
      const before = await sealedColumn(db);
      const booted = await readSettingsToBoot(db, cipher);
      expect([booted.needsReentry, booted.settings.oidc]).toEqual([['oidc'], undefined]);
      expect(await sealedColumn(db)).toBe(before);
    });
  });

  test('null clears the provider, label and all, and a patch that names nothing of it leaves it', async () => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, { oidc: OIDC });
      await saveSettings(db, cipher, clock, { signUp: 'open' });
      expect((await readSettings(db, cipher)).oidc).toEqual(OIDC);
      await saveSettings(db, cipher, clock, { oidc: null });
      const row = await db
        .selectFrom('server_settings')
        .select(['oidc_issuer', 'oidc_client_id', 'oidc_client_secret_encrypted', 'oidc_name'])
        .where('id', '=', true)
        .executeTakeFirstOrThrow();
      expect(Object.values(row)).toEqual([null, null, null, null]);
    });
  });

  test('refuses what the sign-in could not use, before a statement is sent', async () => {
    await withRollback(async (db) => {
      for (const patch of [
        { oidc: { ...OIDC, issuer: '' } },
        { oidc: { ...OIDC, clientId: '' } },
        { oidc: { ...OIDC, clientSecret: '' } },
        { oidc: { ...OIDC, issuer: 'http://login.example.com' } },
        { oidc: { ...OIDC, issuer: 'https://login.example.com/?tenant=1' } },
        { oidc: { ...OIDC, issuer: 'https://login.example.com/#x' } },
        { oidc: { ...OIDC, issuer: 'https://u:p@login.example.com' } },
        { oidc: { ...OIDC, issuer: 'login.example.com' } },
        { oidc: { ...OIDC, name: '' } },
        { oidc: { ...OIDC, name: ' Acme' } },
        { oidc: { ...OIDC, name: 'Ac\u0000me' } },
        { oidc: { ...OIDC, name: 'x'.repeat(41) } },
      ]) {
        const refused = await failure(saveSettings(db, cipher, clock, patch));
        expect(refused).toBeInstanceOf(Error);
        expect({ patch, byTheDatabase: String(refused).includes('violates') }).toEqual({
          patch,
          byTheDatabase: false,
        });
      }
    });
  });

  test.each<[string, boolean, Record<string, string | null>, string]>([
    [
      'an issuer without a client',
      false,
      { oidc_issuer: 'https://login.example.com' },
      'server_settings_oidc_triple',
    ],
    [
      'a client id without its secret',
      false,
      { oidc_client_id: 'only-the-id' },
      'server_settings_oidc_triple',
    ],
    [
      'a label with nothing to label',
      false,
      { oidc_name: 'orphan' },
      'server_settings_oidc_name_needs_provider',
    ],
    ['a blank label', true, { oidc_name: '' }, 'server_settings_oidc_not_blank'],
    ['a blank client id', true, { oidc_client_id: '' }, 'server_settings_oidc_not_blank'],
  ])('the database refuses %s, whoever writes it', async (_what, connected, set, constraint) => {
    await withRollback(async (db) => {
      await saveSettings(db, cipher, clock, connected ? { oidc: OIDC } : {});
      const refused = await failure(
        db.updateTable('server_settings').set(set).where('id', '=', true).execute(),
      );
      expect(String(refused)).toContain(constraint);
    });
  });

  test('the environment’s provider is imported once, and named after as ignored', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      const config = testConfig({
        OIDC_ISSUER: OIDC.issuer,
        OIDC_CLIENT_ID: OIDC.clientId,
        OIDC_CLIENT_SECRET: OIDC.clientSecret,
        OIDC_NAME: OIDC.name,
      });
      expect(await importFromEnvOnce(db, cipher, clock, envSeedOf(config))).toBe('imported');
      expect((await readSettings(db, cipher)).oidc).toEqual(OIDC);
      for (const name of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_NAME']) {
        expect(ignoredEnvironment(config)).toContain(name);
      }
      // The environment is edited and the server restarted: nothing changes.
      const changed = testConfig({
        OIDC_ISSUER: 'https://another.example.com',
        OIDC_CLIENT_ID: 'x',
        OIDC_CLIENT_SECRET: 'y',
      });
      expect(await importFromEnvOnce(db, cipher, clock, envSeedOf(changed))).toBe('already');
      expect((await readSettings(db, cipher)).oidc).toEqual(OIDC);
    });
  });

  test('an environment with none of it imports no provider, and names none as ignored', async () => {
    await withRollback(async (db) => {
      await db.deleteFrom('server_settings').execute();
      const config = testConfig({});
      expect(await importFromEnvOnce(db, cipher, clock, envSeedOf(config))).toBe('imported');
      expect((await readSettings(db, cipher)).oidc).toBeUndefined();
      expect(ignoredEnvironment(config).filter((name) => name.startsWith('OIDC_'))).toEqual([]);
    });
  });
});
