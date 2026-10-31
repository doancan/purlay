/**
 * Invitation e-mails (D-179 §5) against the database: which addresses a request is queued for, the
 * limits that keep the server from being a mail relay — per request, per inviter a day, per workspace
 * a day — that they are counted in the database and given back with a failed request, and who may ask.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import {
  INVITATION_EMAILS_PER_INVITER_PER_DAY,
  INVITATION_EMAILS_PER_WORKSPACE_PER_DAY,
  type CreateInvitationRequest,
} from '@purlay/types';
import { AppError } from '../../platform/errors';
import { DAY_MS, type Clock } from '../../platform/clock';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aMovableClock } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { makeAndMailInvitation, type MailedInvitation } from './invitation-mail';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const APP = 'https://purlay.test';

const send = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
  request: CreateInvitationRequest,
  on = true,
): Promise<MailedInvitation> =>
  await atomicallyOn(db)(
    async (transaction) =>
      await makeAndMailInvitation(transaction, clock, context, request, { on, appUrl: APP }),
  );

const as = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> => {
  const person = room.members[name];
  if (person === undefined) throw new Error(`no ${name}`);
  return await requireWorkspaceMembership(db, person.userId, room.workspaceId);
};

const addresses = (count: number, prefix = 'p'): string[] =>
  Array.from({ length: count }, (_, n) => `${prefix}${String(n)}@example.test`);

const outcomes = (made: MailedInvitation): string[] =>
  (made.created.mail ?? []).map((entry) => entry.outcome);

const count = (made: MailedInvitation, outcome: string): number =>
  outcomes(made).filter((found) => found === outcome).length;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.then(
    () => null,
    (failure: unknown) => failure,
  );
  if (!(error instanceof AppError)) throw new Error(`expected a refusal, got ${String(error)}`);
  return error.body.code;
};

const spent = async (db: Executor, like: string): Promise<number> => {
  const { rows } = await sql<{ count: number }>`
    select coalesce(sum(count), 0)::int as count from rate_limits where key like ${like}
  `.execute(db);
  return rows[0]?.count ?? 0;
};

describe('integration: mailing an invitation', () => {
  test('one link is made for the request, and a letter is queued for each address with that link', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-owner']);
      const made = await send(db, aMovableClock(), await as(db, room, 'im-owner'), {
        emails: ['ann@example.test', 'bob@example.test'],
        locale: 'en',
      });
      expect(outcomes(made)).toEqual(['queued', 'queued']);
      expect(made.letters.map((letter) => letter.to)).toEqual([
        'ann@example.test',
        'bob@example.test',
      ]);
      for (const letter of made.letters) {
        expect(letter.text).toContain(`${APP}/invite#${made.created.token}`);
        expect(letter.text).toContain('im-owner invited you to join');
      }
      const links = await db
        .selectFrom('workspace_invitations')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(links).toHaveLength(1);
      const audit = await db
        .selectFrom('audit_log')
        .select('action')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(audit.map((row) => row.action)).toEqual(['invitation.created']);
    });
  });

  test('a request with no addresses is the link alone, as it always was', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-plain']);
      const clock = aMovableClock();
      const context = await as(db, room, 'im-plain');
      for (const request of [{}, { emails: [] }]) {
        const made = await send(db, clock, context, request);
        expect(made.created.mail).toBeUndefined();
        expect(made.letters).toEqual([]);
      }
      expect(await spent(db, 'purlay:invite-mail:%')).toBe(0);
    });
  });

  test('an address typed again in any case, or padded, is counted and mailed once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-dupe']);
      const made = await send(db, aMovableClock(), await as(db, room, 'im-dupe'), {
        emails: ['Ann@Example.test', ' ann@example.TEST ', 'ANN@example.test', 'bob@example.test'],
      });
      expect(made.created.mail).toEqual([
        { address: 'ann@example.test', outcome: 'queued' },
        { address: 'bob@example.test', outcome: 'queued' },
      ]);
      expect(made.letters).toHaveLength(2);
      expect(await spent(db, 'purlay:invite-mail:inviter:%')).toBe(2);
    });
  });

  test('an address that is not one is reported invalid, once, and is neither mailed nor counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-bad']);
      const made = await send(db, aMovableClock(), await as(db, room, 'im-bad'), {
        emails: ['nope', 'x<victim@example.test>', 'a@b.test,c@d.test', 'nope', 'ok@example.test'],
      });
      expect(made.created.mail).toEqual([
        { address: 'nope', outcome: 'invalid' },
        { address: 'x<victim@example.test>', outcome: 'invalid' },
        { address: 'a@b.test,c@d.test', outcome: 'invalid' },
        { address: 'ok@example.test', outcome: 'queued' },
      ]);
      expect(made.letters.map((letter) => letter.to)).toEqual(['ok@example.test']);
      expect(await spent(db, 'purlay:invite-mail:inviter:%')).toBe(1);
    });
  });

  test('without a relay nothing is queued or counted, each address says unavailable, and the link is made', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-nomail']);
      const made = await send(
        db,
        aMovableClock(),
        await as(db, room, 'im-nomail'),
        { emails: ['ann@example.test', 'nope'] },
        false,
      );
      expect(outcomes(made)).toEqual(['unavailable', 'invalid']);
      expect(made.letters).toEqual([]);
      expect(made.created.token).toMatch(/^[0-9a-f]{64}$/);
      expect(await spent(db, 'purlay:invite-mail:%')).toBe(0);
    });
  });

  test('an inviter has fifty letters a day: the rest of a request is refused for that, and nothing is spent past it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-limit']);
      const clock = aMovableClock();
      const context = await as(db, room, 'im-limit');
      const first = await send(db, clock, context, { emails: addresses(20, 'a') });
      const second = await send(db, clock, context, { emails: addresses(20, 'b') });
      const third = await send(db, clock, context, { emails: addresses(20, 'c') });
      expect([count(first, 'queued'), count(second, 'queued'), count(third, 'queued')]).toEqual([
        20, 20, 10,
      ]);
      expect(count(third, 'inviter_limit')).toBe(10);
      expect(third.created.mail?.slice(0, 10).map((entry) => entry.outcome)).toEqual(
        Array.from({ length: 10 }, () => 'queued'),
      );
      expect(third.letters).toHaveLength(10);
      const fourth = await send(db, clock, context, { emails: ['late@example.test'] });
      expect(outcomes(fourth)).toEqual(['inviter_limit']);
      expect(fourth.letters).toEqual([]);
      // The link is made whatever: a refused address is not a dead end.
      expect(fourth.created.token).toMatch(/^[0-9a-f]{64}$/);
      expect(await spent(db, 'purlay:invite-mail:inviter:%')).toBe(
        INVITATION_EMAILS_PER_INVITER_PER_DAY,
      );
    });
  });

  test('a workspace has two hundred a day whoever asks, and an inviter refused by it is not charged for the refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-ws-a', 'im-ws-b']);
      const clock = aMovableClock();
      const workspaceKey = `purlay:invite-mail:workspace:${room.workspaceId}`;
      await sql`
        insert into rate_limits (key, count, last_request)
        values (${workspaceKey}, ${INVITATION_EMAILS_PER_WORKSPACE_PER_DAY - 5}, ${String(clock.now().getTime() + DAY_MS / 2)})
      `.execute(db);
      for (const name of ['im-ws-a', 'im-ws-b']) {
        await db
          .updateTable('workspace_members')
          .set({ role: 'admin' })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', room.members[name]?.userId ?? '')
          .execute();
      }
      const made = await send(db, clock, await as(db, room, 'im-ws-a'), {
        emails: addresses(8),
      });
      expect([count(made, 'queued'), count(made, 'workspace_limit')]).toEqual([5, 3]);
      // Charged for the five only, so the other allowance is not spent on what the first refused.
      expect(
        await spent(db, `purlay:invite-mail:inviter:${room.members['im-ws-a']?.userId ?? ''}`),
      ).toBe(5);
      const other = await send(db, clock, await as(db, room, 'im-ws-b'), {
        emails: ['more@example.test'],
      });
      expect(outcomes(other)).toEqual(['workspace_limit']);
      expect(
        await spent(db, `purlay:invite-mail:inviter:${room.members['im-ws-b']?.userId ?? ''}`),
      ).toBe(0);
    });
  });

  test('a day closes: a day after the first letter the allowance is whole again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-day']);
      const clock = aMovableClock();
      const context = await as(db, room, 'im-day');
      await send(db, clock, context, { emails: addresses(20, 'a') });
      await send(db, clock, context, { emails: addresses(20, 'b') });
      await send(db, clock, context, { emails: addresses(10, 'c') });
      clock.advance(DAY_MS - 1);
      expect(outcomes(await send(db, clock, context, { emails: ['x@example.test'] }))).toEqual([
        'inviter_limit',
      ]);
      clock.advance(1);
      const next = await send(db, clock, context, { emails: addresses(20, 'd') });
      expect(count(next, 'queued')).toBe(20);
    });
  });

  test('a member makes no link and sends no letter; nothing is counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-boss', 'im-member']);
      const code = await refusal(
        send(db, aMovableClock(), await as(db, room, 'im-member'), {
          emails: ['ann@example.test'],
        }),
      );
      expect(code).toBe('FORBIDDEN');
      expect(await spent(db, 'purlay:invite-mail:%')).toBe(0);
    });
  });

  test('another workspace’s admin cannot send for this one: the workspace is not found, and nothing is made or counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['im-home']);
      const elsewhere = await aRoom(db, ['im-away']);
      const away = elsewhere.members['im-away'];
      if (away === undefined) throw new Error('no away');
      const guard = await requireWorkspaceMembership(db, away.userId, room.workspaceId).then(
        () => 'let in',
        (failure: unknown) => (failure instanceof AppError ? failure.body.code : 'other'),
      );
      expect(guard).toBe('WORKSPACE_NOT_FOUND');
      // And a context forged for the wrong workspace is no door either: the role is read again, now.
      const forged: WorkspaceContext = {
        ...(await as(db, elsewhere, 'im-away')),
        workspaceId: room.workspaceId,
      };
      expect(
        await refusal(send(db, aMovableClock(), forged, { emails: ['ann@example.test'] })),
      ).toBe('WORKSPACE_NOT_FOUND');
      expect(await spent(db, 'purlay:invite-mail:%')).toBe(0);
      const links = await db
        .selectFrom('workspace_invitations')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(links).toEqual([]);
    });
  });

  test('a request whose transaction is rolled back gives back what it took: no link, no count', async () => {
    const made = await cloned.db
      .transaction()
      .execute(async (transaction) => {
        const room = await aRoom(transaction, ['im-back']);
        await makeAndMailInvitation(
          transaction,
          aMovableClock(),
          await as(transaction, room, 'im-back'),
          { emails: addresses(3) },
          { on: true, appUrl: APP },
        );
        expect(await spent(transaction, 'purlay:invite-mail:inviter:%')).toBeGreaterThan(0);
        throw new Error('rolled back');
      })
      .then(
        () => 'committed',
        (failure: unknown) => (failure instanceof Error ? failure.message : 'other'),
      );
    expect(made).toBe('rolled back');
    expect(await spent(cloned.db, 'purlay:invite-mail:%')).toBe(0);
  });

  test('requests at once never take more than the allowance', async () => {
    const room = await cloned.db.transaction().execute(async (transaction) => {
      const created = await aRoom(transaction, ['im-race']);
      return created;
    });
    // aRoom committed on the cloned database: the people exist for real, as separate connections need.
    const clock = aMovableClock();
    const context = await requireWorkspaceMembership(
      cloned.db,
      room.members['im-race']?.userId ?? '',
      room.workspaceId,
    );
    const answers = await Promise.all(
      Array.from(
        { length: 6 },
        async (_, n) =>
          await send(cloned.db, clock, context, { emails: addresses(20, `r${String(n)}-`) }),
      ),
    );
    expect(answers.reduce((sum, made) => sum + count(made, 'queued'), 0)).toBe(
      INVITATION_EMAILS_PER_INVITER_PER_DAY,
    );
    expect(await spent(cloned.db, `purlay:invite-mail:inviter:${context.userId}`)).toBe(
      INVITATION_EMAILS_PER_INVITER_PER_DAY,
    );
  });
});
