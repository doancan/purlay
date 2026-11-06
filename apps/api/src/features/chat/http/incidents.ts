/**
 * A channel's incident through HTTP (#487, D-137): read by anyone who can see the channel; declared,
 * moved and resolved by anyone in it. A change tells everyone watching the channel
 * (`INCIDENT_UPDATED`), after the commit, and only when it was one.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import {
  ChangeIncidentRequest,
  DeclareIncidentRequest,
  OlderPageQuery,
  SavePostmortemRequest,
  type Incident,
  type IncidentResponse,
  type IncidentUpdatePage,
} from '@purlay/types';
import { requireChannelById } from '../channels/guard';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishIncidentUpdated,
} from '../../../platform/events';
import { atomicallyOn } from '../../../platform/transactions';
import {
  changeIncident,
  channelIncident,
  declareIncident,
  incidentUpdates,
  savePostmortem,
  type IncidentWrite,
} from '../incidents/incidents';
import { addResponder, removeResponder } from '../incidents/responders';
import type { ChannelDependencies, ChannelWriteDependencies } from '../../../ingress/http/channels';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';

const told = async (
  { bus, clock, log = NO_LOG }: ChannelWriteDependencies,
  write: IncidentWrite,
): Promise<Incident> => {
  if (write.changed) {
    await publishAfterCommit(log, [
      [
        publication('INCIDENT_UPDATED', () =>
          publishIncidentUpdated(bus, clock, write.incident.channelId),
        ),
      ],
    ]);
  }
  return write.incident;
};

/** `GET /api/channels/:channelId/incident` — the open one, or the latest; null when never. */
const readIncident = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<IncidentResponse> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return { incident: await channelIncident(database, context) };
};

/** `POST /api/channels/:channelId/incident` — declared; the same declaration again is answered. */
export const postIncident = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<IncidentWrite> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(DeclareIncidentRequest, body);
  const write = await atomicallyOn(database)(
    async (transaction) => await declareIncident(transaction, clock, context, input),
  );
  await told(dependencies, write);
  return write;
};

/** `PATCH /api/channels/:channelId/incident/:incidentId` — moved, or how bad it is, or resolved. */
export const patchIncident = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  incidentId: string,
  body: unknown,
): Promise<Incident> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(ChangeIncidentRequest, body);
  const write = await atomicallyOn(database)(
    async (transaction) => await changeIncident(transaction, clock, context, incidentId, input),
  );
  return await told(dependencies, write);
};

/** `GET /api/channels/:channelId/incident/:incidentId/updates` — its timeline, newest first. */
const listIncidentUpdates = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
  incidentId: string,
): Promise<IncidentUpdatePage> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await incidentUpdates(database, context, incidentId, query);
};

/** `PUT` and `DELETE /api/channels/:channelId/incident/:incidentId/responders/:userId` */
export const putResponder = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  incidentId: string,
  userId: string,
  responding: boolean,
): Promise<Incident> => {
  const { database, clock } = dependencies;
  const { userId: callerId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, callerId, channelId);
  const change = responding ? addResponder : removeResponder;
  const write = await atomicallyOn(database)(
    async (transaction) => await change(transaction, clock, context, incidentId, userId),
  );
  return await told(dependencies, write);
};

/** `PUT /api/channels/:channelId/incident/:incidentId/postmortem` — saved from the version it was read at. */
export const putPostmortem = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  incidentId: string,
  body: unknown,
): Promise<Incident> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(SavePostmortemRequest, body);
  const write = await atomicallyOn(database)(
    async (transaction) => await savePostmortem(transaction, clock, context, incidentId, input),
  );
  return await told(dependencies, write);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const incidentRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/channels/:channelId/incident',
      async ({ request, params }) => await readIncident(context, request, params.channelId),
    )
    .post('/api/channels/:channelId/incident', async ({ request, params, body, set }) => {
      const { incident, changed } = await postIncident(context, request, params.channelId, body);
      // Made now is 201; the same declaration again is the incident it made, 200 (D-33).
      set.status = changed ? 201 : 200;
      return incident;
    })
    .patch(
      '/api/channels/:channelId/incident/:incidentId',
      async ({ request, params, body }) =>
        await patchIncident(context, request, params.channelId, params.incidentId, body),
    )
    .put(
      '/api/channels/:channelId/incident/:incidentId/postmortem',
      async ({ request, params, body }) =>
        await putPostmortem(context, request, params.channelId, params.incidentId, body),
    )
    .put(
      '/api/channels/:channelId/incident/:incidentId/responders/:userId',
      async ({ request, params }) =>
        await putResponder(
          context,
          request,
          params.channelId,
          params.incidentId,
          params.userId,
          true,
        ),
    )
    .delete(
      '/api/channels/:channelId/incident/:incidentId/responders/:userId',
      async ({ request, params }) =>
        await putResponder(
          context,
          request,
          params.channelId,
          params.incidentId,
          params.userId,
          false,
        ),
    )
    .get(
      '/api/channels/:channelId/incident/:incidentId/updates',
      async ({ request, params }) =>
        await listIncidentUpdates(context, request, params.channelId, params.incidentId),
    );
