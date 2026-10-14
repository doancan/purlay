/**
 * A channel's incident through HTTP (#487, D-137): read by anyone who can see the channel; declared,
 * moved and resolved by anyone in it. A change tells everyone watching the channel
 * (`INCIDENT_UPDATED`), after the commit, and only when it was one.
 */
import {
  ChangeIncidentRequest,
  DeclareIncidentRequest,
  OlderPageQuery,
  type Incident,
  type IncidentResponse,
  type IncidentUpdatePage,
} from '@purlay/types';
import { requireChannelById } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishIncidentUpdated,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import {
  changeIncident,
  channelIncident,
  declareIncident,
  incidentUpdates,
  type IncidentWrite,
} from '../../modules/incidents/incidents';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

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
export const readIncident = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<IncidentResponse> => {
  const { userId } = await requireSession(database, clock, request);
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
  const { userId } = await requireSession(database, clock, request);
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
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(ChangeIncidentRequest, body);
  const write = await atomicallyOn(database)(
    async (transaction) => await changeIncident(transaction, clock, context, incidentId, input),
  );
  return await told(dependencies, write);
};

/** `GET /api/channels/:channelId/incident/:incidentId/updates` — its timeline, newest first. */
export const listIncidentUpdates = async (
  { database, clock }: ChannelDependencies,
  request: Request,
  channelId: string,
  incidentId: string,
): Promise<IncidentUpdatePage> => {
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(OlderPageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await incidentUpdates(database, context, incidentId, query);
};
