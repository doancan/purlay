/** Real native users, memberships and sessions shared by company identity integration suites. */
import type { Executor } from '@purlay/db';
import { credentialCipher } from '../platform/crypto';
import { aMovableClock } from './doubles';
import { aRoom } from './rooms';
import { requireWorkspaceMembership } from '../platform/tenancy';
import { randomToken, tokenDigest } from '../platform/tokens';
import { NO_SESSION_LIFETIME } from '../modules/auth/session-lifetime';
import type {
  CompanyIdentityActor,
  CompanyIdentityDependencies,
} from '../modules/workspaces/identity/authority';

export const companyIdentityFixture = async (
  database: Executor,
): Promise<{
  readonly dependencies: CompanyIdentityDependencies;
  readonly actor: CompanyIdentityActor;
  readonly move: (milliseconds: number) => void;
  readonly member: CompanyIdentityActor;
}> => {
  const room = await aRoom(database, ['company-owner', 'company-member']);
  const clock = aMovableClock(new Date('2026-11-12T03:00:00Z'));
  const dependencies: CompanyIdentityDependencies = {
    database,
    clock,
    cipher: credentialCipher(Buffer.alloc(32, 7).toString('base64')),
    lifetime: () => NO_SESSION_LIFETIME,
  };
  const actors: CompanyIdentityActor[] = [];
  for (const name of ['company-owner', 'company-member']) {
    const userId = room.members[name]?.userId ?? '';
    const session = await database
      .insertInto('sessions')
      .values({
        user_id: userId,
        token_hash: await tokenDigest(randomToken()),
        created_at: clock.now(),
        last_used_at: clock.now(),
        expires_at: new Date(clock.now().getTime() + 7 * 86_400_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    actors.push({
      context: await requireWorkspaceMembership(database, userId, room.workspaceId),
      sessionId: session.id,
    });
  }
  const actor = actors[0];
  const member = actors[1];
  if (actor === undefined || member === undefined) throw new Error('Missing test actors');
  return { dependencies, actor, member, move: clock.advance };
};
