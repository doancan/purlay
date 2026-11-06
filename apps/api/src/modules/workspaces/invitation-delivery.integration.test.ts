import { atomicallyOn } from '../../platform/transactions';
/** Recipient isolation, durable receipts, bounded history, role changes and verified acceptance on real SQL. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  closeIntegrationDatabase,
  withRollback,
  type Transaction,
} from '@purlay/db';
import { type InvitationDelivery, type InvitationRecipientStatus, messageId } from '@purlay/types';
import { aRoom, type Room } from '../../testing/rooms';
import { aUserRow } from '../../testing/users';
import { aMovableClock } from '../../testing/doubles';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import {
  type MailedInvitation,
  type InvitationLetter,
  makeAndMailInvitation,
  resendInvitationRecipient,
  revokeInvitationRecipient,
} from './invitation-mail';
import {
  finishInvitationAttempt,
  listInvitationRecipients,
  listInvitationDeliveries,
  recordInvitationApplicant,
} from './invitation-delivery';
import { acceptInvitation, listInvitations, previewInvitation } from './invitations';

afterAll(async () => {
  await closeIntegrationDatabase();
});
interface Setup {
  room: Room;
  context: WorkspaceContext;
  member: Room['members'][string];
  clock: ReturnType<typeof aMovableClock>;
  mail: { on: boolean; appUrl: string };
  made: MailedInvitation;
  ann: InvitationLetter;
  bob: InvitationLetter;
  annId: string;
  bobId: string;
}
const setup = async (db: Transaction): Promise<Setup> => {
  const room = await aRoom(db, ['delivery-owner', 'delivery-member']);
  const owner = room.members['delivery-owner'];
  const member = room.members['delivery-member'];
  if (owner === undefined || member === undefined) throw new Error('room missing');
  const context = await requireWorkspaceMembership(db, owner.userId, room.workspaceId);
  const clock = aMovableClock();
  const mail = { on: true, appUrl: 'https://purlay.test' };
  const made = await makeAndMailInvitation(
    db,
    clock,
    context,
    { emails: ['ann@example.test', 'bob@example.test'] },
    mail,
  );
  const [ann, bob] = made.letters;
  if (ann === undefined || bob === undefined) throw new Error('letters missing');
  const recipients = await listInvitationRecipients(db, clock, context, {});
  const annId = recipients.data.find((r) => r.address === ann.to)?.id;
  const bobId = recipients.data.find((r) => r.address === bob.to)?.id;
  if (annId === undefined || bobId === undefined) throw new Error('recipients missing');
  return { room, context, member, clock, mail, made, ann, bob, annId, bobId };
};
const token = (text: string): string => {
  const found = /\/invite#([0-9a-f]{64})/.exec(text)?.[1];
  if (found === undefined) throw new Error('token missing');
  return found;
};

const refusal = async (work: Promise<unknown>): Promise<unknown> => {
  const result = await work.then(
    () => null,
    (error: unknown) => error,
  );
  if (result === null) throw new Error('expected a refusal');
  return result;
};

describe('integration: persistent invitation recipients', () => {
  test('every lifecycle filter uses the returned status, including exact time boundaries and admission precedence', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      const check = async (status: InvitationRecipientStatus, id = w.annId): Promise<void> => {
        const filtered = await listInvitationRecipients(db, w.clock, w.context, { status });
        expect(filtered.data.every((r) => r.status === status)).toBe(true);
        expect(filtered.data.some((r) => r.id === id)).toBe(true);
      };
      await check('queued');
      w.clock.advance(120_000);
      await check('unknown');
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, { accepted: true });
      await check('accepted');
      await finishInvitationAttempt(db, w.clock, w.bob.attemptId, {
        accepted: false,
        code: 'EENVELOPE',
      });
      await check('failed', w.bobId);
      const attempt = await db
        .selectFrom('workspace_invitation_mail_attempts')
        .select('invitation_id')
        .where('id', '=', w.ann.attemptId)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('workspace_invitations')
        .set({ revoked_at: w.clock.now(), expires_at: w.clock.now() })
        .where('id', '=', attempt.invitation_id)
        .execute();
      await check('revoked');
      await db
        .updateTable('workspace_invitations')
        .set({ revoked_at: null })
        .where('id', '=', attempt.invitation_id)
        .execute();
      await check('expired');
      await db
        .updateTable('workspace_invitations')
        .set({ expires_at: new Date(w.clock.now().getTime() + 60_000) })
        .where('id', '=', attempt.invitation_id)
        .execute();
      const applicant = await aUserRow(db, 'filter-applicant');
      await db
        .updateTable('users')
        .set({ email: 'ann@example.test', email_verified: true, admission_state: 'pending' })
        .where('id', '=', applicant.userId)
        .execute();
      await recordInvitationApplicant(db, w.clock, applicant.userId, attempt.invitation_id);
      await check('pending');
      for (const admission_state of ['approved', 'denied'] as const) {
        await db
          .updateTable('users')
          .set({ admission_state })
          .where('id', '=', applicant.userId)
          .execute();
        await check(admission_state);
      }
      await db
        .updateTable('workspace_invitation_recipients')
        .set({ joined_at: w.clock.now() })
        .where('id', '=', w.annId)
        .execute();
      await check('joined');
      await db
        .updateTable('users')
        .set({ deleted_at: w.clock.now() })
        .where('id', '=', applicant.userId)
        .execute();
      await check('joined');
      await db
        .updateTable('workspace_invitation_recipients')
        .set({ joined_at: null })
        .where('id', '=', w.annId)
        .execute();
      await check('accepted');
    });
  });
  test('search and status filter before pagination and treat address wildcards literally', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, {
        accepted: false,
        code: 'EENVELOPE',
      });
      await finishInvitationAttempt(db, w.clock, w.bob.attemptId, { accepted: true });
      const matches = await listInvitationRecipients(db, w.clock, w.context, {
        q: ' ANN@EXAMPLE ',
        status: 'failed',
        limit: 1,
      });
      expect(matches.data.map((r) => r.id)).toEqual([w.annId]);
      expect(matches.data[0]?.status).toBe('failed');
      expect(matches.nextCursor).toBeNull();
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, { q: 'ann', status: 'accepted' }))
          .data,
      ).toEqual([]);
      for (const q of ['%', '_', '\\']) {
        expect((await listInvitationRecipients(db, w.clock, w.context, { q })).data).toEqual([]);
      }
      const first = await listInvitationRecipients(db, w.clock, w.context, {
        q: 'example.test',
        limit: 1,
      });
      expect(first.nextCursor).not.toBeNull();
      const next = await listInvitationRecipients(db, w.clock, w.context, {
        q: 'example.test',
        limit: 1,
        before: first.nextCursor ?? '',
      });
      expect(new Set([...first.data, ...next.data].map((r) => r.id)).size).toBe(2);
      expect(next.nextCursor).toBeNull();
    });
  });

  test('copy link is separate; receipts survive reads and contain no secret or SMTP prose', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      expect(new Set([w.made.created.token, token(w.ann.text), token(w.bob.text)]).size).toBe(3);
      expect((await listInvitations(db, w.clock, w.context, {})).data).toHaveLength(1);
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, { accepted: true });
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, {
        accepted: false,
        code: 'EAUTH',
      });
      const page = await listInvitationRecipients(db, w.clock, w.context, {});
      expect(page.data.find((r) => r.id === w.annId)?.latest.result).toBe('accepted');
      expect(JSON.stringify(page)).not.toContain(token(w.ann.text));
      w.clock.advance(120_000);
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
          (r) => r.id === w.bobId,
        )?.latest.result,
      ).toBe('unknown');
      const first = await listInvitationRecipients(db, w.clock, w.context, { limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      const next = await listInvitationRecipients(db, w.clock, w.context, {
        before: first.nextCursor ?? '',
        limit: 1,
      });
      expect(next.data[0]?.id).not.toBe(first.data[0]?.id);
      expect(next.nextCursor).toBeNull();
    });
  });

  test.each([
    'EAUTH',
    'EENVELOPE',
    'EMESSAGE',
    'ETLS',
    'ECONNREFUSED',
    'attacker@example.test secret',
  ])('stores a safe failure for %s', async (code) => {
    await withRollback(async (db) => {
      const w = await setup(db);
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, { accepted: false, code });
      const result = await listInvitationDeliveries(db, w.clock, w.context, w.annId, {});
      expect(result.data[0]?.result).toBe('failed');
      expect(result.data[0]?.failure).toBe(
        (
          {
            EAUTH: 'authentication',
            EENVELOPE: 'recipient',
            EMESSAGE: 'message',
            ETLS: 'tls',
            ECONNREFUSED: 'connection',
          } as Record<string, InvitationDelivery['failure']>
        )[code] ?? 'unknown',
      );
      expect(JSON.stringify(result)).not.toContain(code);
    });
  });

  test('resending rotates one recipient only, keeps paged history, and revocation is idempotent', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      expect(
        await refusal(resendInvitationRecipient(db, w.clock, w.context, w.annId, w.mail)),
      ).toMatchObject({ body: { code: 'RATE_LIMITED' } });
      await finishInvitationAttempt(db, w.clock, w.ann.attemptId, {
        accepted: false,
        code: 'EENVELOPE',
      });
      w.clock.advance(1);
      const again = await resendInvitationRecipient(db, w.clock, w.context, w.annId, w.mail);
      expect(token(again.text)).not.toBe(token(w.ann.text));
      expect(
        await refusal(previewInvitation(db, w.clock, w.member.userId, token(w.ann.text))),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      expect(
        (await previewInvitation(db, w.clock, w.member.userId, token(w.bob.text))).member,
      ).toBe(true);
      expect(
        (await previewInvitation(db, w.clock, w.member.userId, w.made.created.token)).member,
      ).toBe(true);
      const first = await listInvitationDeliveries(db, w.clock, w.context, w.annId, { limit: 1 });
      expect(first.data[0]?.id).toBe(again.attemptId);
      const older = await listInvitationDeliveries(db, w.clock, w.context, w.annId, {
        before: first.nextCursor ?? '',
        limit: 1,
      });
      expect(older.data[0]?.id).toBe(w.ann.attemptId);
      expect(older.data[0]?.revokedAt).not.toBeNull();
      await revokeInvitationRecipient(db, w.clock, w.context, w.annId);
      await revokeInvitationRecipient(db, w.clock, w.context, w.annId);
      expect(
        await refusal(previewInvitation(db, w.clock, w.member.userId, token(again.text))),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
          (r) => r.id === w.annId,
        )?.latest.revokedAt,
      ).not.toBeNull();
    });
  });

  test('an interrupted receipt can be retried manually; unavailable SMTP and exhausted quotas preserve the old link', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      w.clock.advance(120_000);
      expect(
        await refusal(
          resendInvitationRecipient(db, w.clock, w.context, w.annId, { ...w.mail, on: false }),
        ),
      ).toMatchObject({ body: { code: 'EMAIL_SIGN_IN_UNAVAILABLE' } });
      const again = await resendInvitationRecipient(db, w.clock, w.context, w.annId, w.mail);
      await finishInvitationAttempt(db, w.clock, again.attemptId, { accepted: true });
      await db
        .updateTable('rate_limits')
        .set({ count: 200 })
        .where('key', 'like', 'purlay:invite-mail:%')
        .execute();
      expect(
        await refusal(resendInvitationRecipient(db, w.clock, w.context, w.annId, w.mail)),
      ).toMatchObject({ body: { code: 'RATE_LIMITED' } });
      expect(
        (await previewInvitation(db, w.clock, w.member.userId, token(again.text))).member,
      ).toBe(true);
      w.clock.advance(8 * 86_400_000);
      expect(
        await refusal(previewInvitation(db, w.clock, w.member.userId, token(again.text))),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
    });
  });

  test('workspace outsiders and ordinary members cannot see recipients; a demoted manager cannot write', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      const member = await requireWorkspaceMembership(db, w.member.userId, w.room.workspaceId);
      expect(await refusal(listInvitationRecipients(db, w.clock, member, {}))).toMatchObject({
        body: { code: 'FORBIDDEN' },
      });
      expect(
        await refusal(
          listInvitationDeliveries(db, w.clock, w.context, messageId(w.clock.now()), {}),
        ),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      expect(
        await refusal(
          resendInvitationRecipient(db, w.clock, w.context, messageId(w.clock.now()), w.mail),
        ),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      expect(
        await refusal(revokeInvitationRecipient(db, w.clock, w.context, messageId(w.clock.now()))),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      const other = await aRoom(db, ['delivery-other']);
      const outsider = other.members['delivery-other'];
      if (outsider === undefined) throw new Error('missing owner');
      const outside = await requireWorkspaceMembership(db, outsider.userId, other.workspaceId);
      expect((await listInvitationRecipients(db, w.clock, outside, {})).data).toEqual([]);
      expect(
        await refusal(listInvitationDeliveries(db, w.clock, outside, w.annId, {})),
      ).toMatchObject({ body: { code: 'INVITATION_NOT_FOUND' } });
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', w.room.workspaceId)
        .where('user_id', '=', w.context.userId)
        .execute();
      expect(
        await refusal(resendInvitationRecipient(db, w.clock, w.context, w.annId, w.mail)),
      ).toMatchObject({ body: { code: 'FORBIDDEN' } });
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', w.room.workspaceId)
        .where('user_id', '=', w.context.userId)
        .execute();
      expect(
        await refusal(revokeInvitationRecipient(db, w.clock, w.context, w.annId)),
      ).toMatchObject({ body: { code: 'WORKSPACE_NOT_FOUND' } });
    });
  });

  test('only the matching verified owner explicitly using the invitation records approval and joining', async () => {
    await withRollback(async (db) => {
      const w = await setup(db);
      const user = await aUserRow(db, 'delivery-applicant');
      const attempt = await db
        .selectFrom('workspace_invitation_mail_attempts')
        .select('invitation_id')
        .where('id', '=', w.ann.attemptId)
        .executeTakeFirstOrThrow();
      await recordInvitationApplicant(db, w.clock, messageId(w.clock.now()), attempt.invitation_id);
      await recordInvitationApplicant(db, w.clock, user.userId, attempt.invitation_id);
      await db
        .updateTable('users')
        .set({ email: 'ann@example.test', admission_state: 'pending' })
        .where('id', '=', user.userId)
        .execute();
      await recordInvitationApplicant(db, w.clock, user.userId, attempt.invitation_id);
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
          (r) => r.id === w.annId,
        )?.admission,
      ).toBeNull();
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', user.userId)
        .execute();
      await recordInvitationApplicant(db, w.clock, user.userId, attempt.invitation_id);
      await recordInvitationApplicant(db, w.clock, user.userId, attempt.invitation_id);
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
          (r) => r.id === w.annId,
        )?.admission,
      ).toBe('pending');
      await db
        .updateTable('users')
        .set({ admission_state: 'approved' })
        .where('id', '=', user.userId)
        .execute();
      await acceptInvitation(db, w.clock, user.userId, token(w.ann.text));
      const joined = (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
        (r) => r.id === w.annId,
      );
      expect(joined?.joinedAt).not.toBeNull();
      expect(joined?.admission).toBe('approved');
      await db
        .updateTable('users')
        .set({ deleted_at: w.clock.now() })
        .where('id', '=', user.userId)
        .execute();
      await recordInvitationApplicant(db, w.clock, user.userId, attempt.invitation_id);
      expect(
        (await listInvitationRecipients(db, w.clock, w.context, {})).data.find(
          (r) => r.id === w.annId,
        )?.admission,
      ).toBeNull();
    });
  });
});

describe('integration: concurrent invitation changes', () => {
  test('concurrent resend and revoke recheck the latest attempt after waiting; neither revokes a replacement it never saw', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      const w = await atomicallyOn(cloned.db)(setup);
      for (const second of ['revoke', 'resend'] as const) {
        const latest = await cloned.db
          .selectFrom('workspace_invitation_mail_attempts')
          .selectAll()
          .where('recipient_id', '=', w.annId)
          .orderBy('id', 'desc')
          .limit(1)
          .executeTakeFirstOrThrow();
        await finishInvitationAttempt(cloned.db, w.clock, latest.id, { accepted: true });
        let release: () => void = () => undefined;
        let locked: () => void = () => undefined;
        const lockReady = new Promise<void>((resolve) => {
          locked = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        const holding = cloned.db.transaction().execute(async (tx) => {
          await tx
            .selectFrom('workspace_invitations')
            .select('id')
            .where('id', '=', latest.invitation_id)
            .forUpdate()
            .executeTakeFirstOrThrow();
          locked();
          await barrier;
        });
        await lockReady;
        const waiting = async (count: number): Promise<void> => {
          for (let tries = 0; tries < 100; tries++) {
            const { rows } = await sql<{
              n: number;
            }>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%workspace_invitations%'`.execute(
              cloned.db,
            );
            if ((rows[0]?.n ?? 0) >= count) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error('the invitation writers did not reach the held link');
        };
        w.clock.advance(1);
        const first = atomicallyOn(cloned.db)(
          async (tx) => await resendInvitationRecipient(tx, w.clock, w.context, w.annId, w.mail),
        );
        let later: Promise<unknown> | undefined;
        try {
          await waiting(1);
          later = atomicallyOn(cloned.db)(async (tx) => {
            if (second === 'revoke') {
              await revokeInvitationRecipient(tx, w.clock, w.context, w.annId);
              return undefined;
            }
            return await resendInvitationRecipient(tx, w.clock, w.context, w.annId, w.mail);
          });
          await waiting(2);
        } finally {
          release();
        }
        await holding;
        const results = await Promise.allSettled([first, later]);
        expect(results[0].status).toBe('fulfilled');
        expect(results[1].status).toBe('rejected');
        if (results[1].status === 'rejected')
          expect(results[1].reason).toMatchObject({ body: { code: 'RATE_LIMITED' } });
        const newest = (
          await listInvitationRecipients(cloned.db, w.clock, w.context, {})
        ).data.find((r) => r.id === w.annId);
        expect(newest?.latest.revokedAt).toBeNull();
      }
    } finally {
      await cloned.drop();
    }
  }, 30_000);
});
