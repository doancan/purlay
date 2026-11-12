/** Two real company sessions time chat while the volume regression holds the API busy. */
import type { Executor } from '@purlay/db';
import { messageId, parseServerMessage, type ClientFrame, type ServerFrame } from '@purlay/types';
import { p95 } from '../cli/budget-latency';
import type { HttpApplication } from '../ingress/http/app';
import { COMPANY_SESSION_COOKIE } from '../platform/cookies';
import { systemClock } from '../platform/clock';
import { withoutRequest } from '../platform/logging';
import { sessionFromHeaders } from '../modules/auth/sessions';
import { listCompanyConnections } from '../modules/workspaces/identity/connections';
import {
  companyNativeHeaders,
  roundtripCompanyNative,
  type signInCompanyNative,
} from './company-native-auth';

type World = Awaited<ReturnType<typeof signInCompanyNative>>;

const ownerCompanyCookie = async (database: Executor, world: World): Promise<string> => {
  const { fixture, idp } = world;
  const previous = idp.person;
  idp.person = {
    sub: `volume-owner-${fixture.actor.context.userId}`,
    email: 'volume-owner@company.example',
  };
  try {
    const connection = (
      await listCompanyConnections(fixture.dependencies, fixture.actor)
    ).data.find((candidate) => candidate.id === world.connection.id);
    if (connection === undefined) throw new Error('The measured provider is missing');
    const link = await roundtripCompanyNative(
      world,
      {
        workspaceId: fixture.actor.context.workspaceId,
        connectionId: connection.id,
        revision: connection.revision,
        intent: 'link',
      },
      world.ownerCookie,
    );
    if (link.status !== 302) throw new Error('The company listener could not link its identity');
    const workspace = await database
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', fixture.actor.context.workspaceId)
      .executeTakeFirstOrThrow();
    const signIn = await roundtripCompanyNative(
      world,
      {
        workspace: workspace.slug,
        connectionId: connection.id,
      },
      '',
      true,
    );
    const cookie = signIn.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${COMPANY_SESSION_COOKIE}=`))
      ?.split(';')[0];
    if (signIn.status !== 302 || cookie === undefined)
      throw new Error('The company listener could not sign in');
    const session = await sessionFromHeaders(world.auth, companyNativeHeaders(cookie));
    if (
      session?.companyWorkspaceId !== fixture.actor.context.workspaceId ||
      session.userId !== fixture.actor.context.userId
    )
      throw new Error('The listener did not receive its company-scoped native session');
    return cookie;
  } finally {
    idp.person = previous;
  }
};

const connect = async (url: string, cookie: string): Promise<WebSocket> => {
  const socket = new WebSocket(url, {
    headers: { cookie, origin: 'https://purlay.test' },
  } as unknown as string[]);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        if (error === undefined) resolve();
        else reject(error);
      };
      const opened = (): void => {
        finish();
      };
      const failed = (): void => {
        finish(new Error('Company measurement socket upgrade failed'));
      };
      const timer = setTimeout(() => {
        finish(new Error('Company measurement socket did not open'));
      }, 10_000);
      socket.addEventListener('open', opened);
      socket.addEventListener('error', failed);
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
};

const answer = async (socket: WebSocket, frame: ClientFrame): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      socket.removeEventListener('message', receive);
      if (error === undefined) resolve();
      else reject(error);
    };
    const receive = (event: MessageEvent): void => {
      const parsed = parseServerMessage(String(event.data));
      if (parsed.kind === 'malformed') finish(new Error('Malformed company measurement frame'));
      else if (parsed.kind === 'frame' && parsed.frame.refId === frame.id) {
        if (parsed.frame.event === 'ACK') finish();
        else finish(new Error(`Company subscription answered ${parsed.frame.event}`));
      }
    };
    const timer = setTimeout(() => {
      finish(new Error('Company subscription was not answered'));
    }, 10_000);
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify(frame));
  });
};

export interface CompanySocketMeasurement {
  readonly messages: number;
  readonly ackP95Ms: number;
  readonly fanOutP95Ms: number;
}

/** Owns this app's listener until the messages and the caller's concurrent load have both finished. */
export const measureCompanySocketLatency = async ({
  app,
  database,
  world,
  during,
}: {
  readonly app: HttpApplication;
  readonly database: Executor;
  readonly world: World;
  readonly during?: () => Promise<void>;
}): Promise<CompanySocketMeasurement> =>
  await withoutRequest(async () => {
    const listenerCookie = await ownerCompanyCookie(database, world);
    const channel = await database
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', world.fixture.member.context.workspaceId)
      .executeTakeFirstOrThrow();
    const port = app.listen(0);
    const sockets: WebSocket[] = [];
    try {
      const sender = await connect(`ws://localhost:${String(port)}/ws`, world.cookie);
      sockets.push(sender);
      const listener = await connect(`ws://localhost:${String(port)}/ws`, listenerCookie);
      sockets.push(listener);
      for (const socket of sockets)
        await answer(socket, {
          id: messageId(systemClock.now()),
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId: channel.id, afterMessageId: null }] },
        });
      const sentAt = new Map<string, number>();
      const ackTimes = new Map<string, number>();
      const fanOutTimes = new Map<string, number>();
      const failures: string[] = [];
      const receive = (on: 'sender' | 'listener', event: MessageEvent): void => {
        const parsed = parseServerMessage(String(event.data));
        if (parsed.kind === 'malformed') failures.push('A malformed frame was received');
        else if (parsed.kind === 'frame') record(on, parsed.frame);
      };
      const record = (on: 'sender' | 'listener', frame: ServerFrame): void => {
        if (frame.event === 'ERROR') failures.push(`Company send failed: ${frame.data.code}`);
        const id =
          on === 'sender' && frame.event === 'ACK'
            ? frame.refId
            : on === 'listener' && frame.event === 'MESSAGE_CREATED'
              ? frame.data.id
              : undefined;
        const started = id === undefined ? undefined : sentAt.get(id);
        if (id === undefined || started === undefined) return;
        const times = on === 'sender' ? ackTimes : fanOutTimes;
        if (times.has(id)) failures.push(`Duplicate ${on} answer`);
        else times.set(id, performance.now() - started);
      };
      sender.addEventListener('message', (event) => {
        receive('sender', event);
      });
      listener.addEventListener('message', (event) => {
        receive('listener', event);
      });
      const sends = async (): Promise<void> => {
        for (let index = 0; index < 60; index++) {
          if (failures.length > 0) throw new Error(failures.join('; '));
          const id = messageId(systemClock.now());
          sentAt.set(id, performance.now());
          sender.send(
            JSON.stringify({
              id,
              op: 'MESSAGE_SEND',
              payload: { channelId: channel.id, content: `company volume ${String(index)}` },
            } satisfies ClientFrame),
          );
          await Bun.sleep(125);
        }
        const until = performance.now() + 10_000;
        while (
          (ackTimes.size < 60 || fanOutTimes.size < 60) &&
          failures.length === 0 &&
          performance.now() < until
        )
          await Bun.sleep(20);
        if (failures.length > 0) throw new Error(failures.join('; '));
        if (ackTimes.size !== 60 || fanOutTimes.size !== 60)
          throw new Error(
            `Company messages missing: ${String(ackTimes.size)} ACKs and ${String(fanOutTimes.size)} deliveries of 60`,
          );
      };
      // allSettled keeps the listener and database alive until either sibling's work has finished on failure too.
      const outcomes = await Promise.allSettled([sends(), during?.()]);
      const failed = outcomes.find((outcome) => outcome.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const measured = {
        messages: 60,
        ackP95Ms: p95([...ackTimes.values()]),
        fanOutP95Ms: p95([...fanOutTimes.values()]),
      };
      // D-49/D-227: this shared-process behavior test records timing; the independent-process
      // latency gate judges regressions with its baseline and trials, never a single absolute sample.
      return measured;
    } finally {
      for (const socket of sockets) socket.close();
      await app.stop(true);
    }
  });
