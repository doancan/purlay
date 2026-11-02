/**
 * The invitation passport's own rules (D-179 §5, Ruling R51), asked of the module directly: liveness read
 * at every use and not only when the passport was made, one winner when two spend one, and the cap of
 * twenty held when requests come at once.
 *
 * On a cloned database, because the last two are races between real connections (D-46, D-77).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock, HOUR_MS } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import { tokenDigest } from '../../platform/tokens';
import { aUserRow } from '../../testing/users';
import {
  consumePassport,
  issuePassport,
  PASSPORT_TTL_MS,
  PASSPORTS_PER_INVITATION,
  passportAllows,
  PassportRefused,
} from './invitation-passport';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const later = (ms: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + ms));

/** A workspace and a live link into it, directly: the token, and what to do to the link. */
const aLink = async (): Promise<{ token: string; id: string; workspaceId: string }> => {
  const owner = await aUserRow(cloned.db, `pp-${crypto.randomUUID().slice(0, 6)}`);
  const { id: workspaceId } = await cloned.db
    .insertInto('workspaces')
    .values({ name: 'Passports', slug: `pp-${crypto.randomUUID().slice(0, 8)}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const token = crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
  const id = messageId(NOW);
  await cloned.db
    .insertInto('workspace_invitations')
    .values({
      id,
      workspace_id: workspaceId,
      token_hash: await tokenDigest(token),
      created_by: owner.userId,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 7 * 24 * HOUR_MS),
    })
    .execute();
  return { token, id, workspaceId };
};

const issue = async (token: string, email?: string, at = clock): Promise<{ cookie?: string }> =>
  await atomicallyOn(cloned.db)(
    async (transaction) => await issuePassport(transaction, at, { token, email }),
  );

/** What a call throws, or nothing. */
const refusal = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('integration: invitation passports', () => {
  test('a cookie’s passport allows a sign-up until the link stops opening, however it stops', async () => {
    const stops: readonly [
      string,
      (link: { id: string; workspaceId: string }) => Promise<unknown>,
    ][] = [
      [
        'revoked',
        async ({ id }): Promise<unknown> =>
          await cloned.db
            .updateTable('workspace_invitations')
            .set({ revoked_at: NOW })
            .where('id', '=', id)
            .execute(),
      ],
      [
        'expired',
        async ({ id }): Promise<unknown> =>
          await cloned.db
            .updateTable('workspace_invitations')
            .set({ expires_at: new Date(NOW.getTime() + 1000) })
            .where('id', '=', id)
            .execute(),
      ],
      [
        'its workspace deleted',
        async ({ workspaceId }): Promise<unknown> =>
          await cloned.db
            .updateTable('workspaces')
            .set({ deleted_at: NOW })
            .where('id', '=', workspaceId)
            .execute(),
      ],
    ];
    for (const [name, stop] of stops) {
      const link = await aLink();
      const { cookie } = await issue(link.token);
      const presented = { cookie };
      expect(await passportAllows(cloned.db, clock, presented), name).toBeDefined();
      await stop(link);
      // Read again at the use: a link that stopped opening takes its unspent passports with it.
      const at = name === 'expired' ? later(2000) : clock;
      expect(await passportAllows(cloned.db, at, presented), name).toBeUndefined();
    }
  });

  test('spending is refused for a passport whose link stopped opening, or past its hour, or spent', async () => {
    const link = await aLink();
    const { cookie } = await issue(link.token);
    const id = await passportAllows(cloned.db, clock, { cookie });
    if (id === undefined) throw new Error('the passport was not found');

    // Past its hour: not spendable, though the row is there.
    expect(await consumePassport(cloned.db, id, later(PASSPORT_TTL_MS + 1))).toBe(false);
    // Its link revoked: not spendable.
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ revoked_at: NOW })
      .where('id', '=', link.id)
      .execute();
    expect(await consumePassport(cloned.db, id, clock)).toBe(false);
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ revoked_at: null })
      .where('id', '=', link.id)
      .execute();
    // Live: spent once, and then never again.
    expect(await consumePassport(cloned.db, id, clock)).toBe(true);
    expect(await consumePassport(cloned.db, id, clock)).toBe(false);
    expect(await passportAllows(cloned.db, clock, { cookie })).toBeUndefined();
  });

  test('of many spending one passport at once, exactly one wins', async () => {
    const link = await aLink();
    const { cookie } = await issue(link.token);
    const id = await passportAllows(cloned.db, clock, { cookie });
    if (id === undefined) throw new Error('the passport was not found');
    const results = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await atomicallyOn(cloned.db)(
            async (transaction) => await consumePassport(transaction, id, clock),
          ),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  test('an address’s passport answers to that address alone, in any spelling of it', async () => {
    const link = await aLink();
    const address = `Pass.Port-${crypto.randomUUID().slice(0, 6)}@Example.test`;
    await issue(link.token, `  ${address}  `);
    const lower = address.toLowerCase();
    expect(await passportAllows(cloned.db, clock, { email: lower })).toBeDefined();
    expect(await passportAllows(cloned.db, clock, { email: address.toUpperCase() })).toBeDefined();
    expect(await passportAllows(cloned.db, clock, { email: `x${lower}` })).toBeUndefined();
    expect(
      await passportAllows(cloned.db, clock, { email: lower.replace('@', 'x@') }),
    ).toBeUndefined();
    expect(await passportAllows(cloned.db, clock, { email: 'not an address' })).toBeUndefined();
    expect(await passportAllows(cloned.db, clock, {})).toBeUndefined();
    // And a cookie is not an address: the two kinds are not interchangeable.
    expect(await passportAllows(cloned.db, clock, { cookie: lower })).toBeUndefined();
  });

  test('twenty at once are made and the rest refused, however many ask together', async () => {
    const link = await aLink();
    // Two already there, so the pool's batches of four step over the cap rather than land on it; and the
    // insert held open a moment, so a batch's requests all count before any of them has committed.
    await issue(link.token);
    await issue(link.token);
    await sql`
      create function hold_passport_insert() returns trigger language plpgsql as
      $$ begin perform pg_sleep(0.05); return new; end $$
    `.execute(cloned.db);
    await sql`create trigger hold_passports before insert on invitation_passports for each row execute function hold_passport_insert()`.execute(
      cloned.db,
    );
    let outcomes: string[];
    try {
      outcomes = await Promise.all(
        Array.from({ length: 30 }, async () => {
          try {
            await issue(link.token);
            return 'made';
          } catch (error) {
            if (error instanceof PassportRefused && error.reason === 'too-many') return 'refused';
            throw error;
          }
        }),
      );
    } finally {
      await sql`drop trigger hold_passports on invitation_passports`.execute(cloned.db);
      await sql`drop function hold_passport_insert()`.execute(cloned.db);
    }
    expect(outcomes.filter((outcome) => outcome === 'made')).toHaveLength(
      PASSPORTS_PER_INVITATION - 2,
    );
    const live = await cloned.db
      .selectFrom('invitation_passports')
      .select('id')
      .where('invitation_id', '=', link.id)
      .execute();
    expect(live).toHaveLength(PASSPORTS_PER_INVITATION);
  });

  test('a spent passport frees its place under the cap, and an expired one does too', async () => {
    const link = await aLink();
    const cookies: string[] = [];
    for (let made = 0; made < PASSPORTS_PER_INVITATION; made += 1) {
      cookies.push((await issue(link.token)).cookie ?? '');
    }
    expect(await refusal(async () => await issue(link.token))).toBeInstanceOf(PassportRefused);
    const id = await passportAllows(cloned.db, clock, { cookie: cookies[0] });
    if (id === undefined) throw new Error('the passport was not found');
    expect(await consumePassport(cloned.db, id, clock)).toBe(true);
    // One place is free now, and only one.
    expect((await issue(link.token)).cookie).toBeDefined();
    expect(await refusal(async () => await issue(link.token))).toBeInstanceOf(PassportRefused);
  });
});
