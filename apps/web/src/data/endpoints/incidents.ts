// A channel’s incident: declared, changed, answered by responders, written up.
import {
  Incident,
  IncidentResponse,
  IncidentUpdatePage,
  type ChangeIncidentRequest,
  type DeclareIncidentRequest,
  type SavePostmortemRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface IncidentsApi {
  /** A channel's open incident, or its latest; null when it never had one (D-137). */
  readonly incident: (channelId: string, signal?: AbortSignal) => Promise<IncidentResponse>;
  /** Declares one, at the client's id: the same again answers the incident it made (D-137 §5). */
  readonly declareIncident: (channelId: string, input: DeclareIncidentRequest) => Promise<Incident>;
  readonly changeIncident: (
    channelId: string,
    incidentId: string,
    input: ChangeIncidentRequest,
  ) => Promise<Incident>;
  /** Brings somebody in the channel in to respond, or takes them off (D-137 §3). */
  readonly respond: (
    channelId: string,
    incidentId: string,
    userId: string,
    responding: boolean,
  ) => Promise<Incident>;
  /** Saves the postmortem from the version it was edited from (D-137 §5). */
  readonly savePostmortem: (
    channelId: string,
    incidentId: string,
    input: SavePostmortemRequest,
  ) => Promise<Incident>;
  /** An incident's timeline, newest first; older than `before` (D-137 §4). */
  readonly incidentUpdates: (
    channelId: string,
    incidentId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<IncidentUpdatePage>;
}

export const createIncidentsApi = (http: Http): IncidentsApi => ({
  incident: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/incident`,
      IncidentResponse,
      options({}, signal),
    ),
  declareIncident: (channelId, input) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/incident`,
      Incident,
      options({ body: input }),
    ),
  changeIncident: (channelId, incidentId, input) =>
    http.request(
      'PATCH',
      `/api/channels/${at(channelId)}/incident/${at(incidentId)}`,
      Incident,
      options({ body: input }),
    ),
  respond: (channelId, incidentId, userId, responding) =>
    http.request(
      responding ? 'PUT' : 'DELETE',
      `/api/channels/${at(channelId)}/incident/${at(incidentId)}/responders/${at(userId)}`,
      Incident,
      options(),
    ),
  savePostmortem: (channelId, incidentId, input) =>
    http.request(
      'PUT',
      `/api/channels/${at(channelId)}/incident/${at(incidentId)}/postmortem`,
      Incident,
      options({ body: input }),
    ),
  incidentUpdates: (channelId, incidentId, before, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/incident/${at(incidentId)}/updates`,
      IncidentUpdatePage,
      options(before === undefined ? {} : { query: { before } }, signal),
    ),
});
